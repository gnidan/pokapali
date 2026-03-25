/**
 * Re-export positional evaluation from
 * @pokapali/document for backwards compatibility.
 */
import type { View, Cache } from "@pokapali/document";
import { inspect } from "@pokapali/document";
import type { History } from "@pokapali/document";

export function evaluateAt<V>(
  view: View<V>,
  tree: History,
  position: number,
  cache: Cache<V>,
): V {
  return inspect(view, tree, cache, { at: position });
}
