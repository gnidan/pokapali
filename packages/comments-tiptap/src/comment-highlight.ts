/**
 * Tiptap extension for comment anchor highlighting.
 *
 * Creates ProseMirror Decorations for resolved comment
 * anchors. CSS classes: .comment-anchor, .active.
 * Attribute: data-comment-id.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { ySyncPluginKey } from "y-prosemirror";
import { resolveAnchors, type ResolvedCommentAnchor } from "./resolve.js";

export { type ResolvedCommentAnchor };

export const commentHighlightKey = new PluginKey("commentHighlight");

/** Meta key to signal comment data changed. */
const REBUILD_META = "commentHighlight:rebuild";

/**
 * Dispatch a transaction to rebuild comment
 * decorations. Call when comments change externally.
 */
export function rebuildCommentDecorations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any,
): void {
  if (!view) return;
  const tr = view.state.tr.setMeta(REBUILD_META, true);
  view.dispatch(tr);
}

function buildDecorations(
  doc: EditorState["doc"],
  anchors: ResolvedCommentAnchor[],
  activeId: string | null,
): DecorationSet {
  if (anchors.length === 0) return DecorationSet.empty;

  const decorations = anchors.map((a) => {
    const isActive = a.id === activeId;
    return Decoration.inline(a.from, a.to, {
      class: isActive ? "comment-anchor active" : "comment-anchor",
      "data-comment-id": a.id,
    });
  });

  return DecorationSet.create(doc, decorations);
}

export interface CommentHighlightOptions {
  commentsDoc: Y.Doc | null;
  contentDoc: Y.Doc | null;
  activeCommentId: string | null;
}

export const CommentHighlight = Extension.create<CommentHighlightOptions>({
  name: "commentHighlight",

  addOptions() {
    return {
      commentsDoc: null,
      contentDoc: null,
      activeCommentId: null,
    };
  },

  addProseMirrorPlugins() {
    const { commentsDoc, contentDoc } = this.options;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ext = this;

    return [
      new Plugin({
        key: commentHighlightKey,
        state: {
          init(_: unknown, state: EditorState): DecorationSet {
            if (!commentsDoc || !contentDoc) {
              return DecorationSet.empty;
            }
            const syncState = ySyncPluginKey.getState(state);
            const anchors = resolveAnchors(commentsDoc, contentDoc, syncState);
            return buildDecorations(
              state.doc,
              anchors,
              ext.options.activeCommentId,
            );
          },
          apply(
            tr: Transaction,
            old: DecorationSet,
            _oldState: EditorState,
            newState: EditorState,
          ): DecorationSet {
            if (!commentsDoc || !contentDoc) {
              return DecorationSet.empty;
            }
            const needsRebuild = tr.docChanged || tr.getMeta(REBUILD_META);
            if (!needsRebuild) return old;

            const syncState = ySyncPluginKey.getState(newState);
            const anchors = resolveAnchors(commentsDoc, contentDoc, syncState);
            return buildDecorations(
              newState.doc,
              anchors,
              ext.options.activeCommentId,
            );
          },
        },
        props: {
          decorations(state: EditorState): DecorationSet {
            return commentHighlightKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
