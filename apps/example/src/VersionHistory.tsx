import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import DiffMatchPatch from "diff-match-patch";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import type { Doc, VersionEntry } from "@pokapali/core";
import type { VersionHistoryData } from "./useVersionHistory";

const dmp = new DiffMatchPatch();

// ── Types ────────────────────────────────────────

type PreviewState =
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

// ── Restore helper ───────────────────────────────

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

// ── Diff view (inline additions/deletions) ───────

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => {
    const diffs = dmp.diff_main(oldText, newText);
    dmp.diff_cleanupSemantic(diffs);
    return diffs;
  }, [oldText, newText]);

  return (
    <div className="vh-diff">
      {parts.map(([op, text], i) => {
        if (op === DiffMatchPatch.DIFF_INSERT) {
          return (
            <span key={i} className="vh-diff-add">
              {text}
            </span>
          );
        }
        if (op === DiffMatchPatch.DIFF_DELETE) {
          return (
            <span key={i} className="vh-diff-del">
              {text}
            </span>
          );
        }
        return <span key={i}>{text}</span>;
      })}
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
  history,
  onClose,
}: {
  doc: Doc;
  editor: Editor | null;
  /** Preloaded version history data from useVersionHistory. */
  history: VersionHistoryData;
  onClose: () => void;
}) {
  const { versions, listState, versionTexts, deltas, visibleVersions } =
    history;

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>({
    status: "idle",
  });
  const [unavailable, setUnavailable] = useState<Set<number>>(new Set());
  const [confirmEntry, setConfirmEntry] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const tipCidStr = doc.tipCid?.toString() ?? null;

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

  const selectedEntry =
    selectedSeq != null ? versions.find((v) => v.seq === selectedSeq) : null;
  const selectedIsCurrent =
    selectedEntry != null &&
    tipCidStr != null &&
    selectedEntry.cid.toString() === tipCidStr;

  // Diff texts for the selected version vs predecessor
  const diffPair = useMemo<{
    oldText: string;
    newText: string;
  } | null>(() => {
    if (preview.status !== "loaded") return null;
    const newText = versionTexts.get(preview.seq);
    if (newText === undefined) return null;
    const idx = versions.findIndex((v) => v.seq === preview.seq);
    if (idx < 0) return null;
    const prev = versions[idx + 1];
    if (!prev) return { oldText: "", newText };
    const oldText = versionTexts.get(prev.seq);
    if (oldText === undefined) return null;
    return { oldText, newText };
  }, [preview, versions, versionTexts]);

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
            <Spinner label="Loading history…" />
          )}

          {listState.status === "error" && (
            <div className="vh-error">{listState.message}</div>
          )}

          {listState.status === "idle" && visibleVersions.length === 0 && (
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

          {listState.status === "idle" &&
            versions.length > 0 &&
            versions[versions.length - 1].seq > 1 && (
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
              <div className="vh-preview-header">
                <span>Version #{preview.seq}</span>
                {canRestore && (
                  <button
                    className="vh-restore-btn"
                    onClick={() => setConfirmEntry(selectedEntry!)}
                    disabled={restoring}
                  >
                    {restoring ? "Restoring…" : "Restore"}
                  </button>
                )}
                {selectedIsCurrent && (
                  <span className="vh-current-label">Current version</span>
                )}
              </div>
              {diffPair ? (
                <DiffView
                  oldText={diffPair.oldText}
                  newText={diffPair.newText}
                />
              ) : (
                <VersionPreview ydoc={preview.ydoc} />
              )}
            </>
          )}
        </div>
      </div>

      {confirmEntry && (
        <RestoreConfirm
          seq={confirmEntry.seq}
          ts={confirmEntry.ts}
          onConfirm={handleRestore}
          onCancel={() => setConfirmEntry(null)}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
