/**
 * Anchor model using Y.RelativePosition.
 * Editor-agnostic — works with raw Yjs type indices.
 *
 * Default content type is Y.Text("default") for
 * character-level anchoring. Tiptap/ProseMirror apps
 * should use the adapter package for XmlFragment
 * position conversion.
 */

import * as Y from "yjs";

/** Opaque anchor — encoded RelativePosition pair. */
export interface Anchor {
  readonly start: Uint8Array;
  readonly end: Uint8Array;
}

export type ResolvedAnchor =
  | { status: "resolved"; start: number; end: number }
  | { status: "orphaned" }
  | { status: "pending" };

/**
 * Build an Anchor from pre-existing RelativePositions.
 * Use this when the caller already has positions (e.g.,
 * from y-prosemirror's absolutePositionToRelativePosition).
 */
export function anchorFromRelativePositions(
  start: Y.RelativePosition,
  end: Y.RelativePosition,
): Anchor {
  return {
    start: Y.encodeRelativePosition(start),
    end: Y.encodeRelativePosition(end),
  };
}

/** Get the default content type from a content doc. */
export function getContentType(contentDoc: Y.Doc): Y.Text {
  return contentDoc.getText("default");
}

/**
 * Create an anchor from raw Yjs indices on the
 * content doc's Text("default"). For editor
 * integrations that already have RelativePositions,
 * use anchorFromRelativePositions() instead.
 */
export function createAnchor(
  contentDoc: Y.Doc,
  startIdx: number,
  endIdx: number,
): Anchor {
  const contentType = getContentType(contentDoc);
  return anchorFromRelativePositions(
    Y.createRelativePositionFromTypeIndex(contentType, startIdx),
    Y.createRelativePositionFromTypeIndex(contentType, endIdx),
  );
}

/**
 * Resolve stored anchor bytes against the current
 * content doc state. Returns three-state result:
 * - resolved: both positions map to valid indices
 * - orphaned: anchored text was deleted
 * - pending: content not loaded yet (empty doc)
 */
export function resolveAnchor(
  contentDoc: Y.Doc,
  startBytes: Uint8Array,
  endBytes: Uint8Array,
): ResolvedAnchor {
  const contentType = getContentType(contentDoc);

  // If the content type has no content, content
  // hasn't loaded yet.
  if (contentType.length === 0) {
    return { status: "pending" };
  }

  const startPos = Y.decodeRelativePosition(startBytes);
  const endPos = Y.decodeRelativePosition(endBytes);

  const absStart = Y.createAbsolutePositionFromRelativePosition(
    startPos,
    contentDoc,
  );
  const absEnd = Y.createAbsolutePositionFromRelativePosition(
    endPos,
    contentDoc,
  );

  if (absStart === null || absEnd === null) {
    return { status: "orphaned" };
  }

  return {
    status: "resolved",
    start: absStart.index,
    end: absEnd.index,
  };
}
