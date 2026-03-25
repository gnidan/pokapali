/**
 * History: a finger tree of epochs with monoidal
 * navigation index.
 *
 * This is the core data structure for a document's
 * edit history. Each element is an Epoch; the cached
 * Summary at every internal node enables O(log n)
 * navigation queries via split predicates.
 */
import type { FingerTree } from "@pokapali/finger-tree";
import { fromArray, empty, split, concat, snoc } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import type { Summary } from "./summary.js";
import { epochMeasured } from "./summary.js";
import type { Epoch } from "./epoch.js";
import { Epoch as EpochCompanion } from "./epoch.js";
import type { Edit } from "./edit.js";
import type { Snapshot } from "./builders.js";
import {
  fromSnapshots as buildFromSnapshots,
  backfillEdits as buildBackfillEdits,
} from "./builders.js";

/**
 * A finger tree of Epochs, indexed by Summary.
 */
export type History = FingerTree<Summary, Epoch>;

/** @deprecated Use `History` instead. */
export type EpochTree = History;

/**
 * Companion object for the History type.
 *
 * Provides static-like constructor functions and
 * tree-level operations.
 */
export const History = {
  /**
   * An empty History.
   */
  empty(): History {
    return empty();
  },

  /**
   * Build a History from an array of epochs.
   */
  fromEpochs(epochs: readonly Epoch[]): History {
    return fromArray(epochMeasured, epochs);
  },

  /**
   * Build a coarse History from a snapshot chain.
   *
   * Each snapshot becomes an epoch with empty edits
   * and a snapshotted boundary.
   */
  fromSnapshots(snapshots: readonly Snapshot[]): History {
    return buildFromSnapshots(snapshots);
  },

  /**
   * Merge two adjacent epochs in a tree at the given
   * 1-based position.
   *
   * Position N means: merge epoch N-1 and epoch N
   * (0-indexed), i.e. the boundary between the Nth
   * and (N+1)th epochs is removed.
   *
   * Valid range: 1 <= position < tree.length
   *
   * Returns a new tree with one fewer epoch.
   */
  mergeAdjacent(tree: History, position: number): History {
    if (position < 1) {
      throw new Error("Position must be >= 1");
    }

    const s = split(epochMeasured, (v) => v.epochCount >= position, tree);
    if (!s) {
      throw new Error("Position beyond tree size");
    }

    const s2 = split(epochMeasured, (v) => v.epochCount >= 1, s.right);
    if (!s2) {
      throw new Error("Position beyond tree size");
    }

    const merged = EpochCompanion.merge(s.value, s2.value);

    return concat(epochMeasured, snoc(epochMeasured, s.left, merged), s2.right);
  },

  /**
   * Distribute edits across epochs defined by a
   * snapshot chain.
   *
   * For each edit, finds the snapshot where it first
   * appears — contained by snapshot[i] but NOT by
   * snapshot[i-1]. This places the edit in the epoch
   * where it was new. Edits not contained by any
   * snapshot go into a trailing closed epoch.
   *
   * Returns a tree with edits distributed across
   * epochs matching the snapshot boundaries.
   */
  backfill(
    snapshots: readonly Snapshot[],
    edits: readonly Edit[],
    codec: Codec,
  ): History {
    return buildBackfillEdits(snapshots, edits, codec);
  },
};

/**
 * Build a History from an array of epochs.
 */
export function fromEpochs(epochs: readonly Epoch[]): History {
  return History.fromEpochs(epochs);
}

/**
 * An empty History.
 */
export function emptyTree(): History {
  return History.empty();
}
