import { useState, useEffect, useCallback, useRef } from "react";
import type { Doc as YDoc } from "yjs";
import type { Doc, VersionEntry } from "@pokapali/core";
import type { VersionHistoryData } from "./useVersionHistory";

// ── Types ────────────────────────────────────────

type LoadState =
  | { status: "idle" }
  | { status: "loading"; seq: number }
  | { status: "loaded"; seq: number; ydoc: YDoc }
  | {
      status: "error";
      seq: number;
      message: string;
      /** True when the error is a "not found" that
       *  could resolve on retry. */
      retryable: boolean;
      /** Current retry attempt (0 = first try). */
      attempt: number;
    };

/** Backoff schedule in ms: 1s, 3s, 10s. */
const RETRY_DELAYS = [1_000, 3_000, 10_000];
const MAX_RETRIES = RETRY_DELAYS.length;

// ── Helpers ──────────────────────────────────────

function relativeAge(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function relativeExpiry(expiresAt: number | null | undefined): string | null {
  if (expiresAt == null) return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expires soon";
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs < 1) return "expires soon";
  if (hrs < 24) {
    return hrs === 1 ? "~1 hour left" : `~${hrs} hours left`;
  }
  const days = Math.round(hrs / 24);
  return days === 1 ? "~1 day left" : `~${days} days left`;
}

function isTransientError(msg: string): boolean {
  return /not found|unknown cid/i.test(msg);
}

// ── Version list item ────────────────────────────

function VersionListItem({
  entry,
  selected,
  current,
  fetchStatus,
  retrying,
  delta,
  onSelect,
}: {
  entry: VersionEntry;
  selected: boolean;
  current: boolean;
  /** null = available, "archived" = thinned by
   *  pinner, "unavailable" = genuinely failed */
  fetchStatus: "archived" | "unavailable" | null;
  retrying: boolean;
  delta: number | undefined;
  onSelect: () => void;
}) {
  const disabled = fetchStatus != null;
  return (
    <button
      className={
        "vh-item" +
        (selected ? " selected" : "") +
        (fetchStatus === "archived" ? " archived" : "") +
        (fetchStatus === "unavailable" ? " unavailable" : "") +
        (retrying ? " retrying" : "")
      }
      data-testid="vh-entry"
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      aria-current={selected ? "true" : undefined}
      title={
        fetchStatus === "archived"
          ? "Version archived"
          : fetchStatus === "unavailable"
            ? "Version unavailable"
            : retrying
              ? "Retrying…"
              : current
                ? "Current version"
                : `Version ${entry.seq}`
      }
    >
      <span className="vh-item-seq">
        #{entry.seq}
        {current && <span className="vh-current-badge">current</span>}
      </span>
      {delta !== undefined && (
        <span
          className={
            "vh-item-delta" +
            (delta > 0 ? " added" : delta < 0 ? " removed" : " unchanged")
          }
        >
          {delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "±0"}
        </span>
      )}
      <span className="vh-item-ts">{relativeAge(entry.ts)}</span>
      {entry.tier && entry.tier !== "tip" && (
        <span className={"vh-item-retention vh-tier-" + entry.tier}>
          {entry.tier}
          {(() => {
            const exp = relativeExpiry(entry.expiresAt);
            return exp ? ` · ${exp}` : "";
          })()}
        </span>
      )}
    </button>
  );
}

// ── Spinner ──────────────────────────────────────

function Spinner({ label }: { label: string }) {
  return (
    <div className="vh-spinner" aria-label={label}>
      <span className="vh-spinner-dot" />
      <span className="vh-spinner-text">{label}</span>
    </div>
  );
}

// ── Main component ───────────────────────────────

export function VersionHistory({
  doc,
  history,
  onClose,
  onPreview,
  onClosePreview,
}: {
  doc: Doc;
  /** Preloaded version history data. */
  history: VersionHistoryData;
  onClose: () => void;
  /** Called when a version is loaded for preview. */
  onPreview: (entry: VersionEntry, ydoc: YDoc) => void;
  /** Called when the user deselects (closes preview). */
  onClosePreview: () => void;
}) {
  const { versions, listState, deltas, visibleVersions, settling } = history;

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [unavailable, setUnavailable] = useState<
    Map<number, "archived" | "unavailable">
  >(new Map());
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const cancelRef = useRef(false);
  // Monotonic counter — only the latest request
  // should call onPreview.
  const requestRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cancelRef.current = false;
    return () => {
      cancelRef.current = true;
      if (retryTimerRef.current != null) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const tipCidStr = doc.tip.getSnapshot()?.cid?.toString() ?? null;

  // Load a specific version with retry support.
  const selectVersion = useCallback(
    (entry: VersionEntry, attempt = 0) => {
      const requestId = ++requestRef.current;
      setSelectedSeq(entry.seq);
      setLoadState({
        status: "loading",
        seq: entry.seq,
      });

      doc.loadVersion(entry.cid).then(
        (channels) => {
          if (cancelRef.current) return;
          if (requestRef.current !== requestId) {
            return;
          }
          // Clear any retrying state for this seq
          setRetrying((prev) => {
            if (!prev.has(entry.seq)) return prev;
            const next = new Set(prev);
            next.delete(entry.seq);
            return next;
          });
          const ydoc = channels["content"] ?? Object.values(channels)[0];
          if (!ydoc) {
            setLoadState({
              status: "error",
              seq: entry.seq,
              message: "No content in this version",
              retryable: false,
              attempt,
            });
            return;
          }
          setLoadState({
            status: "loaded",
            seq: entry.seq,
            ydoc,
          });
          onPreview(entry, ydoc);
        },
        (err) => {
          if (cancelRef.current) return;
          if (requestRef.current !== requestId) {
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const transient = isTransientError(msg);
          const canRetry = transient && attempt < MAX_RETRIES;

          if (canRetry) {
            // Schedule automatic retry with backoff
            setRetrying((prev) => {
              const next = new Set(prev);
              next.add(entry.seq);
              return next;
            });
            setLoadState({
              status: "error",
              seq: entry.seq,
              message: msg,
              retryable: true,
              attempt,
            });
            retryTimerRef.current = setTimeout(() => {
              if (cancelRef.current) return;
              if (requestRef.current !== requestId) {
                return;
              }
              selectVersion(entry, attempt + 1);
            }, RETRY_DELAYS[attempt]);
          } else {
            // Exhausted retries or non-transient error
            if (transient) {
              const reason =
                entry.tier && entry.tier !== "tip" ? "archived" : "unavailable";
              setUnavailable((prev) => {
                const next = new Map(prev);
                next.set(entry.seq, reason);
                return next;
              });
            }
            setRetrying((prev) => {
              if (!prev.has(entry.seq)) return prev;
              const next = new Set(prev);
              next.delete(entry.seq);
              return next;
            });
            setLoadState({
              status: "error",
              seq: entry.seq,
              message: msg,
              retryable: false,
              attempt,
            });
          }
        },
      );
    },
    [doc, onPreview],
  );

  const archivedCount = [...unavailable.values()].filter(
    (r) => r === "archived",
  ).length;
  const unavailableCount = unavailable.size - archivedCount;

  return (
    <div
      className="vh-drawer"
      role="complementary"
      aria-label="Version history"
    >
      <div className="vh-header">
        <h3>Version history</h3>
        <button
          className="vh-close"
          onClick={onClose}
          aria-label="Close version history"
        >
          &times;
        </button>
      </div>

      <div className="vh-body">
        <div className="vh-list-section">
          {(listState.status === "loading" || settling) && (
            <Spinner label="Loading history…" />
          )}

          {listState.status === "error" && (
            <div className="vh-error">{listState.message}</div>
          )}

          {listState.status === "idle" &&
            !settling &&
            versions.length === 0 && (
              <div className="vh-empty">No versions published yet.</div>
            )}

          {listState.status === "idle" && visibleVersions.length > 0 && (
            <div className="vh-list" role="listbox">
              {visibleVersions.map((entry) => (
                <VersionListItem
                  key={entry.seq}
                  entry={entry}
                  selected={selectedSeq === entry.seq}
                  current={
                    tipCidStr != null && entry.cid.toString() === tipCidStr
                  }
                  fetchStatus={unavailable.get(entry.seq) ?? null}
                  retrying={retrying.has(entry.seq)}
                  delta={deltas.get(entry.seq)}
                  onSelect={() => {
                    if (selectedSeq === entry.seq) {
                      setSelectedSeq(null);
                      setLoadState({
                        status: "idle",
                      });
                      onClosePreview();
                    } else {
                      selectVersion(entry);
                    }
                  }}
                />
              ))}
            </div>
          )}

          {archivedCount > 0 && (
            <div className="vh-archived-note">
              {archivedCount} {archivedCount === 1 ? "version" : "versions"}{" "}
              archived
            </div>
          )}

          {unavailableCount > 0 && (
            <div className="vh-unavailable-note">
              {unavailableCount}{" "}
              {unavailableCount === 1 ? "version" : "versions"} unavailable
              (retries exhausted)
            </div>
          )}

          {listState.status === "idle" &&
            versions.length > 0 &&
            versions[versions.length - 1]!.seq > 1 && (
              <div className="vh-archive-note">
                Older versions have been archived
              </div>
            )}

          {loadState.status === "loading" && (
            <Spinner label="Loading version…" />
          )}
          {loadState.status === "error" && (
            <div className="vh-error">
              {loadState.retryable ? (
                <>
                  Resolving version…{" "}
                  <span className="vh-retry-info">
                    (retry {loadState.attempt + 1}/{MAX_RETRIES})
                  </span>
                </>
              ) : isTransientError(loadState.message) ? (
                unavailable.get(loadState.seq) === "archived" ? (
                  "Version archived"
                ) : (
                  "Version unavailable"
                )
              ) : (
                loadState.message
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
