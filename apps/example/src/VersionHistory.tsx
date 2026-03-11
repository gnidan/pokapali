import { useState, useEffect, useCallback, useRef } from "react";
import type { Doc as YDoc } from "yjs";
import type { Doc, VersionEntry } from "@pokapali/core";
import type { VersionHistoryData } from "./useVersionHistory";

// ── Types ────────────────────────────────────────

type LoadState =
  | { status: "idle" }
  | { status: "loading"; seq: number }
  | { status: "loaded"; seq: number; ydoc: YDoc }
  | { status: "error"; seq: number; message: string };

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

// ── Version list item ────────────────────────────

function VersionListItem({
  entry,
  selected,
  current,
  unavailable,
  delta,
  onSelect,
}: {
  entry: VersionEntry;
  selected: boolean;
  current: boolean;
  unavailable: boolean;
  delta: number | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      className={
        "vh-item" +
        (selected ? " selected" : "") +
        (unavailable ? " unavailable" : "")
      }
      onClick={unavailable ? undefined : onSelect}
      disabled={unavailable}
      aria-current={selected ? "true" : undefined}
      title={
        unavailable
          ? "Version unavailable"
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
}: {
  doc: Doc;
  /** Preloaded version history data. */
  history: VersionHistoryData;
  onClose: () => void;
  /** Called when a version is loaded for preview. */
  onPreview: (entry: VersionEntry, ydoc: YDoc) => void;
}) {
  const { versions, listState, deltas, visibleVersions } = history;

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [unavailable, setUnavailable] = useState<Set<number>>(new Set());
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const tipCidStr = doc.tipCid?.toString() ?? null;

  // Load a specific version, then signal parent.
  const selectVersion = useCallback(
    (entry: VersionEntry) => {
      setSelectedSeq(entry.seq);
      setLoadState({
        status: "loading",
        seq: entry.seq,
      });

      doc
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .loadVersion(entry.cid as any)
        .then(
          (channels) => {
            if (cancelRef.current) return;
            const ydoc = channels["content"] ?? Object.values(channels)[0];
            if (!ydoc) {
              setLoadState({
                status: "error",
                seq: entry.seq,
                message: "No content in this version",
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
            const msg = err instanceof Error ? err.message : String(err);
            if (/not found|unknown cid/i.test(msg)) {
              setUnavailable((prev) => {
                const next = new Set(prev);
                next.add(entry.seq);
                return next;
              });
            }
            setLoadState({
              status: "error",
              seq: entry.seq,
              message: msg,
            });
          },
        );
    },
    [doc, onPreview],
  );

  const unavailableCount = unavailable.size;

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
          {listState.status === "loading" && (
            <Spinner label="Loading history…" />
          )}

          {listState.status === "error" && (
            <div className="vh-error">{listState.message}</div>
          )}

          {listState.status === "idle" && versions.length === 0 && (
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
                  unavailable={unavailable.has(entry.seq)}
                  delta={deltas.get(entry.seq)}
                  onSelect={() => {
                    if (selectedSeq === entry.seq) {
                      setSelectedSeq(null);
                      setLoadState({
                        status: "idle",
                      });
                    } else {
                      selectVersion(entry);
                    }
                  }}
                />
              ))}
            </div>
          )}

          {unavailableCount > 0 && (
            <div className="vh-unavailable-note">
              {unavailableCount}{" "}
              {unavailableCount === 1 ? "version" : "versions"} not available
            </div>
          )}

          {listState.status === "idle" &&
            versions.length > 0 &&
            versions[versions.length - 1].seq > 1 && (
              <div className="vh-archive-note">
                Older versions have been archived
              </div>
            )}

          {loadState.status === "loading" && (
            <Spinner label="Loading version…" />
          )}
          {loadState.status === "error" && (
            <div className="vh-error">
              {/not found|unknown cid/i.test(loadState.message)
                ? "Version unavailable"
                : loadState.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
