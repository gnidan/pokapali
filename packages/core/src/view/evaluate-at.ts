/**
 * Re-export positional evaluation from
 * @pokapali/document for backwards compatibility.
 */
import type { View, Cache } from "@pokapali/document";
import { foldTree } from "@pokapali/document";
import type { History } from "@pokapali/document";

export function evaluateAt<V>(
  view: View<V>,
  tree: History,
  position: number,
  cache: Cache<V>,
): V {
  // Assumes single-channel view — compat shim, to be
  // deleted
  const channel = Object.keys(view.channels)[0]!;
  const measured = view.channels[channel]!;
  return foldTree(measured, tree, cache, {
    at: position,
  });
}
