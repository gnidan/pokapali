import { useEffect, useMemo, useCallback, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import DiffMatchPatch from "diff-match-patch";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import type { Doc, VersionEntry } from "@pokapali/core";

const dmp = new DiffMatchPatch();
const diffHighlightKey = new PluginKey("diffHighlight");

// ── Text extraction with PM position mapping ─────

interface TextWithPositions {
  text: string;
  /** PM position for each character in `text`.
   *  -1 for synthetic block separators. */
  positions: number[];
}

/**
 * Walk a ProseMirror document and extract plain
 * text alongside the PM position of each character.
 * Block boundaries become '\n' with position -1.
 */
function getTextWithPositions(doc: PMNode): TextWithPositions {
  const chars: string[] = [];
  const positions: number[] = [];
  let lastTextEnd = -1;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      // Insert block separator when we jump over
      // structural nodes between text runs.
      if (lastTextEnd >= 0 && pos > lastTextEnd) {
        chars.push("\n");
        positions.push(-1);
      }
      for (let i = 0; i < node.text.length; i++) {
        chars.push(node.text[i]);
        positions.push(pos + i);
      }
      lastTextEnd = pos + node.text.length;
    }
    return true;
  });

  return { text: chars.join(""), positions };
}

// ── Diff decoration extension ────────────────────

/**
 * Computes diff decorations in the plugin init so
 * they're ready as soon as the editor mounts.
 * Pass `currentText` via `.configure()`.
 */
const DiffHighlight = Extension.create<{
  currentText: string;
}>({
  name: "diffHighlight",

  addOptions() {
    return { currentText: "" };
  },

  addProseMirrorPlugins() {
    const currentText = this.options.currentText;
    return [
      new Plugin({
        key: diffHighlightKey,
        state: {
          init(_, state) {
            if (state.doc.content.size <= 2) {
              return DecorationSet.empty;
            }
            return buildDiffDecorations(state.doc, currentText);
          },
          apply(tr, set) {
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return diffHighlightKey.getState(state);
          },
        },
      }),
    ];
  },
});

// ── Build decorations from diff ──────────────────

/** Scan forward from `start` to find the first
 *  non-negative PM position in the map. */
function firstValidPos(
  positions: number[],
  start: number,
  end: number,
): number {
  for (let i = start; i <= end; i++) {
    if (positions[i] >= 0) return positions[i];
  }
  return -1;
}

/** Scan backward from `end` to find the last
 *  non-negative PM position in the map. */
function lastValidPos(positions: number[], start: number, end: number): number {
  for (let i = end; i >= start; i--) {
    if (positions[i] >= 0) return positions[i];
  }
  return -1;
}

function buildDiffDecorations(
  previewDoc: PMNode,
  currentText: string,
): DecorationSet {
  const preview = getTextWithPositions(previewDoc);
  const diffs = dmp.diff_main(currentText, preview.text);
  dmp.diff_cleanupSemantic(diffs);

  const decorations: Decoration[] = [];
  let previewOffset = 0;

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      previewOffset += text.length;
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      // Text in preview version, not in current → green
      const segEnd = previewOffset + text.length - 1;
      const from = firstValidPos(preview.positions, previewOffset, segEnd);
      const last = lastValidPos(preview.positions, previewOffset, segEnd);
      const to = last >= 0 ? last + 1 : -1;
      if (from >= 0 && to > from) {
        decorations.push(
          Decoration.inline(from, to, {
            class: "vh-diff-add",
          }),
        );
      }
      previewOffset += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      // Text in current, not in preview → red widget.
      // Replace synthetic block-boundary '\n' with
      // spaces for continuous inline display.
      const cleaned = text.replace(/\n/g, " ").trim();
      if (cleaned.length === 0) {
        // Pure structural diff — skip
        continue;
      }
      const insertPos =
        previewOffset < preview.positions.length
          ? firstValidPos(
              preview.positions,
              previewOffset,
              preview.positions.length - 1,
            )
          : previewOffset > 0
            ? lastValidPos(preview.positions, 0, previewOffset - 1) + 1
            : 1;
      if (insertPos >= 0) {
        decorations.push(
          Decoration.widget(
            insertPos,
            () => {
              const el = document.createElement("span");
              el.className = "vh-diff-del";
              el.textContent = cleaned;
              return el;
            },
            { side: -1 },
          ),
        );
      }
      // DELETE does not advance preview offset
    }
  }

  return DecorationSet.create(previewDoc, decorations);
}

// ── Restore helper ───────────────────────────────

async function restoreVersion(
  doc: Doc,
  editor: Editor,
  ydoc: YDoc,
): Promise<void> {
  const frag = ydoc.getXmlFragment("default");
  const json = yXmlFragmentToProsemirrorJSON(frag);
  editor.commands.setContent(json);
  await doc.publish();
}

// ── Confirm dialog ───────────────────────────────

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

// ── Toast ────────────────────────────────────────

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

// ── Main overlay component ───────────────────────

export function VersionPreviewOverlay({
  doc,
  liveEditor,
  entry,
  ydoc,
  onClose,
}: {
  doc: Doc;
  liveEditor: Editor | null;
  entry: VersionEntry;
  ydoc: YDoc;
  onClose: () => void;
}) {
  const [confirmEntry, setConfirmEntry] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Extract ProseMirror JSON from the version's YDoc.
  const versionJson = useMemo(() => {
    const frag = ydoc.getXmlFragment("default");
    return yXmlFragmentToProsemirrorJSON(frag);
  }, [ydoc]);

  // Get current editor text for diffing.
  const currentText = useMemo(() => {
    if (!liveEditor) return "";
    const pmDoc = liveEditor.state.doc;
    return getTextWithPositions(pmDoc).text;
  }, [liveEditor]);

  const tipCidStr = doc.tipCid?.toString() ?? null;
  const isCurrent = tipCidStr != null && entry.cid.toString() === tipCidStr;
  const canRestore =
    liveEditor != null && doc.capability.canPushSnapshots && !isCurrent;

  const previewEditor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({ history: false }),
        DiffHighlight.configure({ currentText }),
      ],
      content: versionJson,
    },
    [ydoc, currentText],
  );

  const handleRestore = useCallback(async () => {
    if (!confirmEntry || !liveEditor) return;
    setRestoring(true);
    try {
      await restoreVersion(doc, liveEditor, ydoc);
      setToast(`Restored to version #${confirmEntry.seq}`);
      setConfirmEntry(null);
      setRestoring(false);
      setTimeout(() => onClose(), 1_500);
    } catch (err) {
      setRestoring(false);
      setConfirmEntry(null);
      setToast(err instanceof Error ? err.message : String(err));
    }
  }, [doc, liveEditor, ydoc, confirmEntry, onClose]);

  return (
    <div
      className="version-preview-overlay"
      role="dialog"
      aria-label={`Preview of version #${entry.seq}`}
    >
      <div className="vpo-header">
        <button
          className="vpo-close"
          onClick={onClose}
          aria-label="Close preview"
        >
          &times; Close Preview
        </button>
        <span className="vpo-info">
          Version #{entry.seq}
          <span className="vpo-age">{relativeAge(entry.ts)}</span>
        </span>
        {isCurrent && (
          <span className="vpo-current-label">Current version</span>
        )}
        {canRestore && (
          <button
            className="vpo-restore"
            onClick={() => setConfirmEntry(entry)}
            disabled={restoring}
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
        )}
      </div>
      <div className="vpo-editor">
        <EditorContent editor={previewEditor} />
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
