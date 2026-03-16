/**
 * Bulk anchor resolution — comments Y.Map → PM positions.
 *
 * Reads raw anchor bytes from commentsDoc.getMap("comments")
 * and resolves each via y-prosemirror to ProseMirror
 * document positions. Used for sidebar spatial ordering.
 */

import * as Y from "yjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import type { SyncState } from "./anchor-bridge.js";

/** A comment anchor resolved to PM positions. */
export interface ResolvedCommentAnchor {
  id: string;
  from: number;
  to: number;
}

/**
 * Resolve all comment anchors to PM positions.
 *
 * Iterates commentsDoc.getMap("comments"), decodes
 * each entry's anchorStart/anchorEnd Uint8Array,
 * and converts to PM positions via y-prosemirror's
 * relativePositionToAbsolutePosition.
 *
 * Skips entries where:
 * - anchorStart or anchorEnd is not Uint8Array
 * - Position conversion fails (orphaned anchor)
 * - from >= to (degenerate range)
 */
export function resolveAnchors(
  commentsDoc: Y.Doc,
  contentDoc: Y.Doc,
  syncState: SyncState | null,
): ResolvedCommentAnchor[] {
  if (!syncState?.binding?.mapping) return [];

  const { type, binding } = syncState;
  const xmlFragment = type as Y.XmlFragment;
  const mapping = binding.mapping;
  const commentsMap = commentsDoc.getMap("comments");
  const results: ResolvedCommentAnchor[] = [];

  commentsMap.forEach((entry: unknown, id: string) => {
    if (!(entry instanceof Y.Map)) return;
    const anchorStart = entry.get("anchorStart");
    const anchorEnd = entry.get("anchorEnd");
    if (
      !(anchorStart instanceof Uint8Array) ||
      !(anchorEnd instanceof Uint8Array)
    ) {
      return;
    }

    try {
      const startRelPos = Y.decodeRelativePosition(anchorStart);
      const endRelPos = Y.decodeRelativePosition(anchorEnd);

      const from = relativePositionToAbsolutePosition(
        contentDoc,
        xmlFragment,
        startRelPos,
        mapping,
      );
      const to = relativePositionToAbsolutePosition(
        contentDoc,
        xmlFragment,
        endRelPos,
        mapping,
      );

      if (from != null && to != null && from < to) {
        results.push({ id, from, to });
      }
    } catch {
      // Mapping may be incomplete during editor init
      // or after schema changes — skip this anchor.
    }
  });

  return results;
}
