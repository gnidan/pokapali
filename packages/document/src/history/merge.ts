/**
 * Re-exports for backwards compatibility.
 *
 * New code should use `Epoch.merge` and
 * `History.mergeAdjacent`.
 */
import type { Epoch } from "./epoch.js";
import { Epoch as EpochCompanion } from "./epoch.js";
import type { History } from "./history.js";
import { History as HistoryCompanion } from "./history.js";

/** @deprecated Use `Epoch.merge` instead. */
export function mergeEpochs(a: Epoch, b: Epoch): Epoch {
  return EpochCompanion.merge(a, b);
}

/** @deprecated Use `History.mergeAdjacent`. */
export function mergeAdjacentInTree(tree: History, position: number): History {
  return HistoryCompanion.mergeAdjacent(tree, position);
}
