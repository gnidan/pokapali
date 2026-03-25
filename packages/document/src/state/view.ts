/**
 * State view: merged CRDT payload.
 *
 * Monoidal fold over epochs using Codec.merge.
 * Produces the merged CRDT state (as opaque bytes)
 * across all epochs in the tree.
 *
 * Within an epoch, edits are merged in arbitrary
 * order (CRDT commutativity). Across epochs, the
 * merge is left-to-right (causal order).
 */
import type { Measured } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import type { Epoch } from "../history/epoch.js";
import type { View } from "../view.js";
import { View as ViewCompanion } from "../view.js";

/**
 * Create a View that folds edit payloads using
 * codec.merge.
 *
 * The monoid:
 * - identity: codec.empty()
 * - append: codec.merge(a, b)
 *
 * The measure: merge all edit payloads in the epoch
 * into a single state.
 */
export function view(codec: Codec): View<Uint8Array> {
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

  return ViewCompanion.create({
    name: "merged-payload",
    description: "Merged CRDT state via codec.merge fold",
    measured,
  });
}
