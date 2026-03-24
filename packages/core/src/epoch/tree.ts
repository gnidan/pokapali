/**
 * EpochTree: a finger tree of epochs with monoidal
 * navigation index.
 *
 * This is the core data structure for a document's
 * edit history. Each element is an Epoch; the cached
 * EpochIndex at every internal node enables O(log n)
 * navigation queries via split predicates.
 */
import type { FingerTree } from "@pokapali/finger-tree";
import { fromArray, empty } from "@pokapali/finger-tree";
import type { EpochIndex } from "./index-monoid.js";
import { epochMeasured } from "./index-monoid.js";
import type { Epoch } from "./types.js";

/**
 * A finger tree of Epochs, indexed by EpochIndex.
 */
export type EpochTree = FingerTree<EpochIndex, Epoch>;

/**
 * Build an EpochTree from an array of epochs.
 */
export function fromEpochs(epochs: readonly Epoch[]): EpochTree {
  return fromArray(epochMeasured, epochs);
}

/**
 * An empty EpochTree.
 */
export function emptyTree(): EpochTree {
  return empty();
}
