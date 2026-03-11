import { useState, useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import type { Doc as YDoc } from "yjs";
import type { Doc } from "@pokapali/core";

// ── Types ────────────────────────────────────────

// Mirror the shape from Doc.history() without
// importing CID (not exported from @pokapali/core)
interface VersionEntry {
  cid: unknown;
  seq: number;
  ts: number;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; seq: number }
  | { status: "loaded"; seq: number; ydoc: YDoc }
  | { status: "error"; seq: number; message: string };

// ── Time formatting ──────────────────────────────

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

// ── Version list item ────────────────────────────

function VersionListItem({
  entry,
  selected,
  unavailable,
  onSelect,
}: {
  entry: VersionEntry;
  selected: boolean;
  unavailable: boolean;
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
      title={unavailable ? "Version unavailable" : `Version ${entry.seq}`}
    >
      <span className="vh-item-seq">#{entry.seq}</span>
      <span className="vh-item-ts">{relativeAge(entry.ts)}</span>
    </button>
  );
}

// ── Version preview (read-only Tiptap) ───────────

function VersionPreview({ ydoc }: { ydoc: YDoc }) {
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
      ],
    },
    [ydoc],
  );

  return (
    <div className="vh-preview">
      <EditorContent editor={editor} />
    </div>
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
  onClose,
}: {
  doc: Doc;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [listState, setListState] = useState<LoadState>({
    status: "loading",
  });
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    status: "idle",
  });
  const [unavailable, setUnavailable] = useState<Set<number>>(new Set());
  const cancelRef = useRef(false);

  // Fetch version list on mount
  useEffect(() => {
    cancelRef.current = false;
    setListState({ status: "loading" });

    doc
      .history()
      .then((entries) => {
        if (cancelRef.current) return;
        setVersions(entries);
        setListState({ status: "idle" });
      })
      .catch((err) => {
        if (cancelRef.current) return;
        setListState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelRef.current = true;
    };
  }, [doc]);

  // Load a specific version for preview
  const selectVersion = useCallback(
    (entry: VersionEntry) => {
      setSelectedSeq(entry.seq);
      setPreview({ status: "loading", seq: entry.seq });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.loadVersion(entry.cid as any).then(
        (channels) => {
          if (cancelRef.current) return;
          // Use the "content" channel if available
          const ydoc = channels["content"] ?? Object.values(channels)[0];
          if (!ydoc) {
            setPreview({
              status: "error",
              seq: entry.seq,
              message: "No content in this version",
            });
            return;
          }
          setPreview({
            status: "loaded",
            seq: entry.seq,
            ydoc,
          });
        },
        (err) => {
          if (cancelRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          // Mark as unavailable if block not found
          if (/not found|unknown cid/i.test(msg)) {
            setUnavailable((prev) => {
              const next = new Set(prev);
              next.add(entry.seq);
              return next;
            });
          }
          setPreview({
            status: "error",
            seq: entry.seq,
            message: msg,
          });
        },
      );
    },
    [doc],
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
        {/* Version list */}
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

          {listState.status === "idle" && versions.length > 0 && (
            <div className="vh-list" role="listbox">
              {versions.map((entry) => (
                <VersionListItem
                  key={entry.seq}
                  entry={entry}
                  selected={selectedSeq === entry.seq}
                  unavailable={unavailable.has(entry.seq)}
                  onSelect={() => selectVersion(entry)}
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

          {listState.status === "idle" && versions.length > 0 && (
            <div className="vh-archive-note">
              Older versions have been archived
            </div>
          )}
        </div>

        {/* Preview pane */}
        <div className="vh-preview-section">
          {preview.status === "idle" && (
            <div className="vh-preview-placeholder">
              Select a version to preview
            </div>
          )}

          {preview.status === "loading" && <Spinner label="Loading version…" />}

          {preview.status === "error" && (
            <div className="vh-error">
              {/not found|unknown cid/i.test(preview.message)
                ? "Version unavailable"
                : preview.message}
            </div>
          )}

          {preview.status === "loaded" && (
            <>
              <div className="vh-preview-header">Version #{preview.seq}</div>
              <VersionPreview ydoc={preview.ydoc} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
