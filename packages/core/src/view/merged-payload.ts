/**
 * mergedPayload view.
 *
 * Monoidal fold over epochs using CrdtCodec.merge.
 * Produces the merged CRDT state (as opaque bytes)
 * across all epochs in the tree.
 *
 * Within an epoch, edits are merged in arbitrary
 * order (CRDT commutativity). Across epochs, the
 * merge is left-to-right (causal order).
 */
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "../epoch/types.js";
import type { CrdtCodec } from "../codec/codec.js";
import type { MonoidalView } from "./types.js";
import { monoidalView } from "./types.js";

/**
 * Create a MonoidalView that folds edit payloads
 * using codec.merge.
 *
 * The monoid:
 * - identity: codec.empty()
 * - append: codec.merge(a, b)
 *
 * The measure: merge all edit payloads in the epoch
 * into a single state.
 */
export function mergedPayloadView(codec: CrdtCodec): MonoidalView<Uint8Array> {
  const measured: Measured<Uint8Array, Epoch> = {
    monoid: {
      empty: codec.empty(),
      append: (a, b) => codec.merge(a, b),
    },
    measure: (ep) => {
      let state = codec.empty();
      for (const e of ep.edits) {
        state = codec.merge(state, e.payload);
      }
      return state;
    },
  };

  return monoidalView({
    name: "merged-payload",
    description: "Merged CRDT state via codec.merge fold",
    measured,
  });
}
