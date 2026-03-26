/**
 * Re-export view evaluation from @pokapali/document
 * for backwards compatibility.
 */
import type { View, Cache } from "@pokapali/document";
import { Cache as CacheCompanion, foldTree } from "@pokapali/document";
import type { History } from "@pokapali/document";

export type ViewCache<V> = Cache<V>;

export function createCache<V>(): ViewCache<V> {
  return CacheCompanion.create();
}

export function seedCache<V>(
  cache: ViewCache<V>,
  node: object,
  value: V,
): void {
  CacheCompanion.seed(cache, node, value);
}

export function evaluateMonoidal<V>(
  view: View<V>,
  tree: History,
  cache: ViewCache<V>,
): V {
  // Assumes single-channel view — compat shim, to be
  // deleted
  const channel = Object.keys(view.channels)[0]!;
  const measured = view.channels[channel]!;
  return foldTree(measured, tree, cache);
}
