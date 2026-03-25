/**
 * Compute a CRDT diff between two merged states.
 *
 * This is a plain function — NOT a monoid. Diffs
 * don't compose.
 */
import type { Codec } from "@pokapali/codec";

/**
 * Compute the diff between two CRDT states.
 *
 * Returns the bytes in `after` that are not in
 * `before`, as determined by `codec.diff`.
 */
export function diff(
  codec: Codec,
  before: Uint8Array,
  after: Uint8Array,
): Uint8Array {
  return codec.diff(after, before);
}
