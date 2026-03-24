/**
 * View evaluation engine.
 *
 * Evaluates a MonoidalView over an EpochTree by
 * walking the tree structure and folding with the
 * view's monoid. Results are cached on tree node
 * identity via WeakMap for structural sharing.
 *
 * Evaluation is synchronous. Async scheduling is
 * deferred to the view lifecycle system (S29).
 */
import type { FingerTree, Node, Digit } from "@pokapali/finger-tree";
import type { EpochIndex } from "../epoch/index-monoid.js";
import type { Epoch } from "../epoch/types.js";
import type { MonoidalView } from "./types.js";

// -------------------------------------------------
// ViewCache
// -------------------------------------------------

/**
 * Cache for monoidal view evaluations.
 *
 * Keyed by tree node object identity — when the tree
 * structurally shares nodes across operations, cached
 * values carry over automatically.
 */
export type ViewCache<V> = WeakMap<object, V>;

/** Create an empty view cache. */
export function createCache<V>(): ViewCache<V> {
  return new WeakMap();
}

/**
 * Pre-populate a cache entry for a tree node.
 *
 * Use when a known value exists for a subtree (e.g.,
 * seeding from a snapshot's precomputed state).
 */
export function seedCache<V>(
  cache: ViewCache<V>,
  node: object,
  value: V,
): void {
  cache.set(node, value);
}

// -------------------------------------------------
// evaluateMonoidal
// -------------------------------------------------

/**
 * Evaluate a MonoidalView over an EpochTree.
 *
 * Walks the tree structure recursively, folding with
 * the view's monoid. Caches intermediate results on
 * tree/node object identity via WeakMap.
 *
 * @param view   The monoidal view to evaluate
 * @param tree   The epoch tree
 * @param cache  WeakMap cache for memoization
 * @returns The folded monoidal value
 */
export function evaluateMonoidal<V>(
  view: MonoidalView<V>,
  tree: FingerTree<EpochIndex, Epoch>,
  cache: ViewCache<V>,
): V {
  return walkTree(view, tree, cache, 0);
}

// -------------------------------------------------
// Tree walking (depth-tracked)
// -------------------------------------------------

// At depth 0, elements are Epoch (leaf values).
// At depth > 0, elements are Node<EpochIndex, ?> —
// internal nodes wrapping deeper values.

function walkTree<V>(
  view: MonoidalView<V>,
  tree: FingerTree<unknown, unknown>,
  cache: ViewCache<V>,
  depth: number,
): V {
  const { monoid } = view.measured;

  switch (tree.tag) {
    case "empty":
      return monoid.empty;

    case "single":
      return walkElement(view, tree.a, cache, depth);

    case "deep": {
      // Check cache on the deep node itself
      const cached = cache.get(tree);
      if (cached !== undefined) return cached;

      const prefix = walkDigit(view, tree.prefix, cache, depth);
      const middle = walkTree(view, tree.middle, cache, depth + 1);
      const suffix = walkDigit(view, tree.suffix, cache, depth);

      const result = monoid.append(monoid.append(prefix, middle), suffix);
      cache.set(tree, result);
      return result;
    }
  }
}

function walkElement<V>(
  view: MonoidalView<V>,
  element: unknown,
  cache: ViewCache<V>,
  depth: number,
): V {
  if (depth === 0) {
    // Leaf: element is an Epoch
    return view.measured.measure(element as Epoch);
  }

  // Internal node: element is Node<?, ?>
  const node = element as Node<unknown, unknown>;

  // Check cache on the node object
  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const { monoid } = view.measured;
  let result: V;

  switch (node.tag) {
    case "node2":
      result = monoid.append(
        walkElement(view, node.a, cache, depth - 1),
        walkElement(view, node.b, cache, depth - 1),
      );
      break;
    case "node3":
      result = monoid.append(
        monoid.append(
          walkElement(view, node.a, cache, depth - 1),
          walkElement(view, node.b, cache, depth - 1),
        ),
        walkElement(view, node.c, cache, depth - 1),
      );
      break;
  }

  cache.set(node, result);
  return result;
}

function walkDigit<V>(
  view: MonoidalView<V>,
  digit: Digit<unknown>,
  cache: ViewCache<V>,
  depth: number,
): V {
  const { monoid } = view.measured;

  switch (digit.tag) {
    case "one":
      return walkElement(view, digit.a, cache, depth);
    case "two":
      return monoid.append(
        walkElement(view, digit.a, cache, depth),
        walkElement(view, digit.b, cache, depth),
      );
    case "three":
      return monoid.append(
        monoid.append(
          walkElement(view, digit.a, cache, depth),
          walkElement(view, digit.b, cache, depth),
        ),
        walkElement(view, digit.c, cache, depth),
      );
    case "four":
      return monoid.append(
        monoid.append(
          walkElement(view, digit.a, cache, depth),
          walkElement(view, digit.b, cache, depth),
        ),
        monoid.append(
          walkElement(view, digit.c, cache, depth),
          walkElement(view, digit.d, cache, depth),
        ),
      );
  }
}
