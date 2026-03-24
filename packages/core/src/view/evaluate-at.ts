/**
 * Positional view evaluation.
 *
 * `evaluateAt` evaluates a MonoidalView over a prefix
 * of the tree (the first `position` epochs). Uses
 * finger-tree `split` to extract the prefix, then
 * evaluates with `evaluateMonoidal`. Shared cache
 * means subtree nodes from a full-tree evaluation
 * are reused.
 */
import { split } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import type { MonoidalView } from "./types.js";
import { evaluateMonoidal } from "./evaluate.js";
import type { ViewCache } from "./evaluate.js";
import type { EpochTree } from "../epoch/tree.js";

/**
 * Evaluate a MonoidalView over the first `position`
 * epochs of the tree.
 *
 * position=0 → monoid identity.
 * position >= epochCount → full tree evaluation.
 *
 * Uses `split` on epochCount to extract the prefix,
 * then `evaluateMonoidal` on the left subtree + the
 * split-point epoch.
 *
 * @param view     The monoidal view
 * @param tree     The epoch tree
 * @param position Number of epochs to include (0-based count)
 * @param cache    Shared WeakMap cache
 * @returns The monoidal value over the prefix
 */
export function evaluateAt<V>(
  view: MonoidalView<V>,
  tree: EpochTree,
  position: number,
  cache: ViewCache<V>,
): V {
  const { monoid, measure } = view.measured;

  if (position <= 0) {
    return monoid.empty;
  }

  // Split at the point where epochCount >= position
  const s = split(epochMeasured, (v) => v.epochCount >= position, tree);

  if (!s) {
    // position beyond tree size — evaluate full tree
    return evaluateMonoidal(view, tree, cache);
  }

  // s.left has epochs 0..position-2,
  // s.value is the epoch at position-1
  // Evaluate left subtree + the split-point epoch
  const leftValue = evaluateMonoidal(view, s.left, cache);
  return monoid.append(leftValue, measure(s.value));
}
