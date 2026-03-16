/**
 * Anchor model using Y.RelativePosition.
 * Editor-agnostic — works with any Yjs shared type.
 *
 * Default content type is Y.Text("default"). Pass
 * contentType in CommentsOptions to use XmlFragment
 * or any other AbstractType.
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
  | { status: "pending" }
  | {
      status: "inverted";
      start: number;
      end: number;
    };

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

/**
 * Create an anchor from raw Yjs type indices. For
 * editor integrations that already have
 * RelativePositions, use anchorFromRelativePositions().
 */
export function createAnchor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentType: Y.AbstractType<any>,
  startIdx: number,
  endIdx: number,
): Anchor {
  return anchorFromRelativePositions(
    Y.createRelativePositionFromTypeIndex(contentType, startIdx),
    Y.createRelativePositionFromTypeIndex(contentType, endIdx),
  );
}

/**
 * Resolve stored anchor bytes against the current
 * content doc state. Returns four-state result:
 * - resolved: both positions map to valid indices
 *   with start <= end
 * - inverted: both positions resolved but start > end
 *   (typically caused by a paragraph split moving
 *   one endpoint past the other)
 * - orphaned: anchored text was deleted
 * - pending: content not loaded yet (empty type)
 */
export function resolveAnchor(
  contentDoc: Y.Doc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentType: Y.AbstractType<any>,
  startBytes: Uint8Array,
  endBytes: Uint8Array,
): ResolvedAnchor {
  // If the content type has no content, content
  // hasn't loaded yet.
  if (contentType._length === 0) {
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

  if (absStart.index > absEnd.index) {
    return {
      status: "inverted",
      start: absStart.index,
      end: absEnd.index,
    };
  }

  return {
    status: "resolved",
    start: absStart.index,
    end: absEnd.index,
  };
}
