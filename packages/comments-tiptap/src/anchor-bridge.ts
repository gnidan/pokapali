/**
 * Position bridge between ProseMirror and Yjs.
 *
 * Wraps y-prosemirror's untyped sync plugin state
 * and provides helpers for anchor creation from
 * editor selections.
 */

import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { anchorFromRelativePositions } from "@pokapali/comments";
import type { Anchor } from "@pokapali/comments";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
} from "y-prosemirror";

/**
 * Typed wrapper for y-prosemirror's sync plugin state.
 * Access via `ySyncPluginKey.getState(editorState)`.
 */
export interface SyncState {
  doc: Y.Doc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: Y.AbstractType<any>;
  binding: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapping: any;
  };
}

/**
 * Get the y-prosemirror sync state from the editor.
 * Returns null if the sync plugin is not active.
 */
export function getSyncState(editor: Editor): SyncState | null {
  const state = ySyncPluginKey.getState(editor.state);
  if (!state?.binding?.mapping) return null;
  return state as SyncState;
}

/**
 * Create an Anchor from the current editor selection.
 *
 * Converts PM selection positions to Y.RelativePositions
 * via y-prosemirror, then encodes them as an Anchor.
 *
 * Returns null if:
 * - Selection is collapsed (cursor, no range)
 * - y-prosemirror sync plugin is not active
 * - Position conversion fails
 */
export function anchorFromSelection(editor: Editor): Anchor | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;

  const syncState = getSyncState(editor);
  if (!syncState) return null;

  const { type, binding } = syncState;
  const mapping = binding.mapping;

  const startRel = absolutePositionToRelativePosition(
    from,
    type as Y.XmlFragment,
    mapping,
  );
  const endRel = absolutePositionToRelativePosition(
    to,
    type as Y.XmlFragment,
    mapping,
  );
  if (!startRel || !endRel) return null;

  return anchorFromRelativePositions(startRel, endRel);
}
