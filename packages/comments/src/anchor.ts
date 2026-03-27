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
 * Content type accessor — extracts the right shared
 * type from a Y.Doc. Used by the bridge to create
 * the same type on a temporary doc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ContentTypeAccessor = (doc: Y.Doc) => Y.AbstractType<any>;

/**
 * Derive a ContentTypeAccessor from a live content
 * type. Inspects the type's constructor and name to
 * build a function that can extract the same type
 * from any doc.
 */
export function deriveTypeAccessor(
  contentDoc: Y.Doc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentType: Y.AbstractType<any>,
): ContentTypeAccessor {
  // Find the registered name by scanning doc.share.
  let typeName = "default";
  for (const [name, type] of contentDoc.share) {
    if (type === contentType) {
      typeName = name;
      break;
    }
  }

  if (contentType instanceof Y.XmlFragment) {
    return (doc) => doc.getXmlFragment(typeName);
  }
  return (doc) => doc.getText(typeName);
}

/**
 * Resolve stored anchor bytes against merged CRDT
 * state (bridge pattern). Creates a temporary Y.Doc,
 * applies the payload, and resolves against it.
 *
 * Use this when the live Y.Doc is not available or
 * when resolving against State view output.
 */
export function resolveAnchorFromPayload(
  payload: Uint8Array,
  getContentType: ContentTypeAccessor,
  startBytes: Uint8Array,
  endBytes: Uint8Array,
): ResolvedAnchor {
  const tempDoc = new Y.Doc();
  Y.applyUpdate(tempDoc, payload);
  const contentType = getContentType(tempDoc);
  const result = resolveAnchor(tempDoc, contentType, startBytes, endBytes);
  tempDoc.destroy();
  return result;
}

/**
 * Create a temporary Y.Doc from a CRDT payload and
 * return a resolver function that resolves anchors
 * against it. Call destroy() when done to free the
 * temp doc. Use this to batch-resolve multiple
 * anchors against the same payload (1 doc per batch
 * instead of 1 per anchor).
 */
export function createPayloadResolver(
  payload: Uint8Array,
  getContentType: ContentTypeAccessor,
): {
  resolve(startBytes: Uint8Array, endBytes: Uint8Array): ResolvedAnchor;
  destroy(): void;
} {
  const tempDoc = new Y.Doc();
  Y.applyUpdate(tempDoc, payload);
  const contentType = getContentType(tempDoc);
  return {
    resolve(startBytes, endBytes) {
      return resolveAnchor(tempDoc, contentType, startBytes, endBytes);
    },
    destroy() {
      tempDoc.destroy();
    },
  };
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
