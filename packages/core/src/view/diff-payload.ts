/**
 * diffPayload derived view.
 *
 * Computes CrdtCodec.diff between mergedPayload at
 * two tree positions. NOT a monoid — diffs don't
 * compose. Caller resolves `before` and `after` via
 * `evaluateAt` on mergedPayloadView.
 */
import type { CrdtCodec } from "../codec/codec.js";
import type { DerivedView } from "./types.js";

/**
 * Create a DerivedView that computes the diff between
 * two mergedPayload values.
 *
 * Deps: `{ before: Uint8Array; after: Uint8Array }`
 * — resolved by the caller via evaluateAt on the
 * mergedPayload view at two positions.
 */
export function diffPayloadView(
  codec: CrdtCodec,
): DerivedView<Uint8Array, { before: Uint8Array; after: Uint8Array }> {
  return {
    name: "diff-payload",
    description: "CRDT diff between merged payloads at two positions",
    compute: (_tree, { before, after }) => codec.diff(after, before),
  };
}
