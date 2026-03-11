import { useState, useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import type { Doc } from "@pokapali/core";
import { fetchVersionHistory, type VersionEntry } from "@pokapali/core";

// ── Types ────────────────────────────────────────

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; seq: number }
  | { status: "loaded"; seq: number; ydoc: YDoc }
  | { status: "error"; seq: number; message: string };

// ── Helpers ──────────────────────────────────────

/** Extract the full IPNS name from a doc URL path. */
function ipnsNameFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/");
    const idx = parts.indexOf("doc");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    // malformed
  }
  return "";
}

/** Get pinner HTTP URLs from diagnostics nodes. */
function pinnerHttpUrls(doc: Doc): string[] {
  // NodeInfo doesn't expose httpUrl yet — once it
  // does, extract from doc.diagnostics().nodes.
  // For now, return empty so fetchVersionHistory
  // falls back to local chain walking.
  void doc;
  return [];
}

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

// ── Restore helper ───────────────────────────────
//
// Restore = new version with old content (DC-1).
// App-layer pattern, not a core method (DC-2):
//   loadVersion(cid) → yXmlFragmentToProsemirrorJSON
//     → editor.commands.setContent(json) → publish()

async function restoreVersion(
  doc: Doc,
  editor: Editor,
  cid: unknown,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels = await doc.loadVersion(cid as any);
  const versionDoc = channels["content"] ?? Object.values(channels)[0];
  if (!versionDoc) {
    throw new Error("No content in this version");
  }

  const frag = versionDoc.getXmlFragment("default");
  const json = yXmlFragmentToProsemirrorJSON(frag);
  editor.commands.setContent(json);
  await doc.publish();
}

// ── Version list item ────────────────────────────

function VersionListItem({
  entry,
  selected,
  current,
  unavailable,
  onSelect,
}: {
  entry: VersionEntry;
  selected: boolean;
  current: boolean;
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

// ── Confirm dialog ───────────────────────────────

function RestoreConfirm({
  seq,
  ts,
  onConfirm,
  onCancel,
}: {
  seq: number;
  ts: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="vh-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm restore"
    >
      <div className="vh-confirm">
        <p className="vh-confirm-text">
          Restore to version #{seq} from {relativeAge(ts)}?
        </p>
        <p className="vh-confirm-note">
          This creates a new version with the old content.
        </p>
        <div className="vh-confirm-actions">
          <button className="vh-confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="vh-confirm-ok" onClick={onConfirm}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toast notification ───────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3_000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="vh-toast" role="status">
      {message}
    </div>
  );
}

// ── Main component ───────────────────────────────

export function VersionHistory({
  doc,
  editor,
  onClose,
}: {
  doc: Doc;
  /** Live Tiptap editor for restore operations. */
  editor: Editor | null;
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
  const [confirmEntry, setConfirmEntry] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Current tip CID for marking "current" version
  const tipCidStr = doc.tipCid?.toString() ?? null;

  // Fetch version list via pinner index (falls back
  // to local chain walk)
  useEffect(() => {
    cancelRef.current = false;
    setListState({ status: "loading" });

    const ipns = ipnsNameFromUrl(doc.urls.best);
    const urls = pinnerHttpUrls(doc);

    fetchVersionHistory(urls, ipns, () => doc.history())
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
      setPreview({
        status: "loading",
        seq: entry.seq,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.loadVersion(entry.cid as any).then(
        (channels) => {
          if (cancelRef.current) return;
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

  // Restore flow
  const handleRestore = useCallback(async () => {
    if (!confirmEntry || !editor) return;
    setRestoring(true);
    try {
      await restoreVersion(doc, editor, confirmEntry.cid);
      setToast(`Restored to version #${confirmEntry.seq}`);
      setConfirmEntry(null);
      setRestoring(false);
      // Close drawer after short delay for toast
      setTimeout(() => onClose(), 1_500);
    } catch (err) {
      setRestoring(false);
      setConfirmEntry(null);
      setPreview({
        status: "error",
        seq: confirmEntry.seq,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [doc, editor, confirmEntry, onClose]);

  const unavailableCount = unavailable.size;

  // Is the selected version the current tip?
  const selectedEntry =
    selectedSeq != null ? versions.find((v) => v.seq === selectedSeq) : null;
  const selectedIsCurrent =
    selectedEntry != null &&
    tipCidStr != null &&
    selectedEntry.cid.toString() === tipCidStr;

  // Can restore? Need editor, selected non-current
  // version loaded, and write capability
  const canRestore =
    editor != null &&
    doc.capability.canPushSnapshots &&
    preview.status === "loaded" &&
    !selectedIsCurrent;

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
            <Spinner label="Loading history\u2026" />
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
                  current={
                    tipCidStr != null && entry.cid.toString() === tipCidStr
                  }
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

          {preview.status === "loading" && (
            <Spinner label="Loading version\u2026" />
          )}

          {preview.status === "error" && (
            <div className="vh-error">
              {/not found|unknown cid/i.test(preview.message)
                ? "Version unavailable"
                : preview.message}
            </div>
          )}

          {preview.status === "loaded" && (
            <>
              <div className="vh-preview-header">
                <span>Version #{preview.seq}</span>
                {canRestore && (
                  <button
                    className="vh-restore-btn"
                    onClick={() => setConfirmEntry(selectedEntry!)}
                    disabled={restoring}
                  >
                    {restoring ? "Restoring\u2026" : "Restore"}
                  </button>
                )}
                {selectedIsCurrent && (
                  <span className="vh-current-label">Current version</span>
                )}
              </div>
              <VersionPreview ydoc={preview.ydoc} />
            </>
          )}
        </div>
      </div>

      {/* Confirmation dialog */}
      {confirmEntry && (
        <RestoreConfirm
          seq={confirmEntry.seq}
          ts={confirmEntry.ts}
          onConfirm={handleRestore}
          onCancel={() => setConfirmEntry(null)}
        />
      )}

      {/* Toast notification */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
