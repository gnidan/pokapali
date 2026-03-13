/**
 * Tiptap extension that highlights a pending comment
 * anchor stored as Y.RelativePositions.
 *
 * Unlike selectionPreserver.ts (which stores fragile
 * PM positions that go stale during concurrent edits),
 * this plugin uses Y.RelativePositions that survive
 * document changes by re-resolving on every
 * docChanged transaction.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import {
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";

export interface Anchor {
  start: Uint8Array;
  end: Uint8Array;
}

interface PluginState {
  anchor: Anchor | null;
  decos: DecorationSet;
}

const key = new PluginKey("pendingAnchorHighlight");

const SET_META = "pendingAnchorHighlight:set";
const CLEAR_META = "pendingAnchorHighlight:clear";

/** Set the pending anchor decoration. */
export function setPendingAnchorDecoration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any,
  anchor: Anchor,
) {
  if (!view) return;
  const tr = view.state.tr.setMeta(SET_META, anchor);
  view.dispatch(tr);
}

/** Clear the pending anchor decoration. */
export function clearPendingAnchorDecoration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any,
) {
  if (!view) return;
  const state = key.getState(view.state) as PluginState | undefined;
  if (!state?.anchor) return;
  const tr = view.state.tr.setMeta(CLEAR_META, true);
  view.dispatch(tr);
}

/**
 * Resolve an Anchor to PM positions using the
 * y-prosemirror sync state.
 */
function resolveAnchor(
  anchor: Anchor,
  editorState: EditorState,
): { from: number; to: number } | null {
  const syncState = ySyncPluginKey.getState(editorState);
  if (!syncState?.mapping) return null;

  const { doc: ydoc, type: xmlFragment, mapping } = syncState;

  const startRelPos = Y.decodeRelativePosition(anchor.start);
  const endRelPos = Y.decodeRelativePosition(anchor.end);

  const from = relativePositionToAbsolutePosition(
    ydoc,
    xmlFragment,
    startRelPos,
    mapping,
  );
  const to = relativePositionToAbsolutePosition(
    ydoc,
    xmlFragment,
    endRelPos,
    mapping,
  );

  if (from == null || to == null || from >= to) {
    return null;
  }
  return { from, to };
}

function buildDecos(
  doc: EditorState["doc"],
  from: number,
  to: number,
): DecorationSet {
  return DecorationSet.create(doc, [
    Decoration.inline(from, to, {
      class: "pending-anchor",
    }),
  ]);
}

const EMPTY_STATE: PluginState = {
  anchor: null,
  decos: DecorationSet.empty,
};

export const PendingAnchorHighlight = Extension.create({
  name: "pendingAnchorHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init(): PluginState {
            return EMPTY_STATE;
          },
          apply(
            tr: Transaction,
            old: PluginState,
            _oldState: EditorState,
            newState: EditorState,
          ): PluginState {
            if (tr.getMeta(CLEAR_META)) {
              return EMPTY_STATE;
            }

            const setAnchor = tr.getMeta(SET_META) as Anchor | undefined;
            if (setAnchor) {
              const resolved = resolveAnchor(setAnchor, newState);
              if (!resolved) return EMPTY_STATE;
              return {
                anchor: setAnchor,
                decos: buildDecos(newState.doc, resolved.from, resolved.to),
              };
            }

            // Re-resolve on doc changes so the
            // decoration tracks concurrent edits.
            if (tr.docChanged && old.anchor) {
              const resolved = resolveAnchor(old.anchor, newState);
              if (!resolved) return EMPTY_STATE;
              return {
                anchor: old.anchor,
                decos: buildDecos(newState.doc, resolved.from, resolved.to),
              };
            }

            return old;
          },
        },
        props: {
          decorations(state: EditorState): DecorationSet {
            const pluginState = key.getState(state) as PluginState | undefined;
            return pluginState?.decos ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
