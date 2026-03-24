/**
 * Epoch merging (compaction).
 *
 * Remove the boundary between two adjacent epochs,
 * union their edit bags. This is the monoid operation
 * on epochs — things that can be squished together.
 *
 * Use case: pinner desamples old history to save
 * space. Fine-grained epochs far in the past get
 * merged into coarser ones.
 */
import { split, concat, snoc } from "@pokapali/finger-tree";
import { epochMeasured } from "./index-monoid.js";
import { epoch } from "./types.js";
import type { Epoch } from "./types.js";
import type { EpochTree } from "./tree.js";

/**
 * Merge two epochs: union edits, take b's boundary.
 *
 * Both epochs must have non-open boundaries. You
 * cannot merge into or out of the live tip.
 */
export function mergeEpochs(a: Epoch, b: Epoch): Epoch {
  if (a.boundary.tag === "open") {
    throw new Error("Cannot merge epoch with open boundary");
  }
  if (b.boundary.tag === "open") {
    throw new Error("Cannot merge epoch with open boundary");
  }
  return epoch([...a.edits, ...b.edits], b.boundary);
}

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
export function mergeAdjacentInTree(
  tree: EpochTree,
  position: number,
): EpochTree {
  if (position < 1) {
    throw new Error("Position must be >= 1");
  }

  // Split to find the epoch at `position`
  const s = split(epochMeasured, (v) => v.epochCount >= position, tree);
  if (!s) {
    throw new Error("Position beyond tree size");
  }

  // s.value is epoch at position-1 (0-indexed)
  // We need the next epoch from s.right
  const s2 = split(epochMeasured, (v) => v.epochCount >= 1, s.right);
  if (!s2) {
    throw new Error("Position beyond tree size");
  }

  // Merge the two adjacent epochs
  const merged = mergeEpochs(s.value, s2.value);

  // Rebuild: left ++ [merged] ++ rest
  return concat(epochMeasured, snoc(epochMeasured, s.left, merged), s2.right);
}
