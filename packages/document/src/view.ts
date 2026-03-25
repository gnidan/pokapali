/**
 * View system: monoidal views over the history tree.
 *
 * A **View** wraps a `Measured<V, Epoch>` with
 * metadata — it defines how to project epochs into a
 * monoidal summary and how to navigate the tree using
 * that summary.
 *
 * **Status** tracks the lifecycle of a single view
 * evaluation: pending → computing → ready | stale.
 *
 * **Cache** memoizes intermediate results on tree
 * node identity via WeakMap for structural sharing.
 *
 * **inspect** evaluates a View over a History tree,
 * optionally at a prefix position.
 */
import type { Measured, FingerTree, Node, Digit } from "@pokapali/finger-tree";
import { split } from "@pokapali/finger-tree";
import type { Summary } from "./history/summary.js";
import { epochMeasured } from "./history/summary.js";
import type { Epoch } from "./history/epoch.js";
import type { History } from "./history/history.js";

// -------------------------------------------------
// View (formerly MonoidalView)
// -------------------------------------------------

/**
 * A monoidal view over the history tree.
 *
 * Wraps a `Measured<V, Epoch>` (monoid + projection)
 * with human-readable metadata. The finger tree uses
 * the `measured` field to cache summaries at internal
 * nodes.
 */
export interface View<V> {
  readonly name: string;
  readonly description: string;
  readonly measured: Measured<V, Epoch>;
}

/**
 * Companion object for the View type.
 */
export const View = {
  /**
   * Construct a View.
   */
  create<V>(fields: {
    name: string;
    description: string;
    measured: Measured<V, Epoch>;
  }): View<V> {
    return { ...fields };
  },
};

// -------------------------------------------------
// Status (formerly ViewState)
// -------------------------------------------------

/**
 * Lifecycle state of a single view evaluation.
 *
 * - **pending** — not yet computed
 * - **computing** — computation in progress
 * - **ready** — value available
 * - **stale** — tree changed since last computation;
 *   the previous value is kept for display
 */
export type Status<V> =
  | { readonly tag: "pending" }
  | { readonly tag: "computing" }
  | { readonly tag: "ready"; readonly value: V }
  | {
      readonly tag: "stale";
      readonly lastValue: V;
    };

/**
 * Companion object for the Status type.
 */
export const Status = {
  /** Construct a pending Status. */
  pending<V>(): Status<V> {
    return { tag: "pending" };
  },

  /** Construct a computing Status. */
  computing<V>(): Status<V> {
    return { tag: "computing" };
  },

  /** Construct a ready Status. */
  ready<V>(value: V): Status<V> {
    return { tag: "ready", value };
  },

  /** Construct a stale Status. */
  stale<V>(lastValue: V): Status<V> {
    return { tag: "stale", lastValue };
  },
};

// -------------------------------------------------
// Cache (formerly ViewCache)
// -------------------------------------------------

/**
 * Cache for monoidal view evaluations.
 *
 * Keyed by tree node object identity — when the tree
 * structurally shares nodes across operations, cached
 * values carry over automatically.
 */
export type Cache<V> = WeakMap<object, V>;

/**
 * Companion object for the Cache type.
 */
export const Cache = {
  /** Create an empty view cache. */
  create<V>(): Cache<V> {
    return new WeakMap();
  },

  /**
   * Pre-populate a cache entry for a tree node.
   *
   * Use when a known value exists for a subtree
   * (e.g., seeding from a snapshot's precomputed
   * state).
   */
  seed<V>(cache: Cache<V>, node: object, value: V): void {
    cache.set(node, value);
  },
};

// -------------------------------------------------
// inspect (formerly evaluateMonoidal + evaluateAt)
// -------------------------------------------------

/**
 * Evaluate a View over a History tree.
 *
 * Without options, evaluates over the full tree.
 * With `{ at: n }`, evaluates over the first `n`
 * epochs (prefix evaluation).
 *
 * @param view   The monoidal view
 * @param tree   The history tree
 * @param cache  WeakMap cache for memoization
 * @param opts   Optional `{ at: number }` for prefix
 * @returns The folded monoidal value
 */
export function inspect<V>(
  view: View<V>,
  tree: History,
  cache: Cache<V>,
  opts?: { at: number },
): V {
  if (opts !== undefined) {
    return inspectAt(view, tree, opts.at, cache);
  }
  return walkTree(view, tree, cache, 0);
}

function inspectAt<V>(
  view: View<V>,
  tree: History,
  position: number,
  cache: Cache<V>,
): V {
  const { monoid, measure } = view.measured;

  if (position <= 0) {
    return monoid.empty;
  }

  const s = split(epochMeasured, (v) => v.epochCount >= position, tree);

  if (!s) {
    return inspect(view, tree, cache);
  }

  const leftValue = inspect(view, s.left, cache);
  return monoid.append(leftValue, measure(s.value));
}

// -------------------------------------------------
// Tree walking (depth-tracked)
// -------------------------------------------------

function walkTree<V>(
  view: View<V>,
  tree: FingerTree<unknown, unknown>,
  cache: Cache<V>,
  depth: number,
): V {
  const { monoid } = view.measured;

  switch (tree.tag) {
    case "empty":
      return monoid.empty;

    case "single":
      return walkElement(view, tree.a, cache, depth);

    case "deep": {
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
  view: View<V>,
  element: unknown,
  cache: Cache<V>,
  depth: number,
): V {
  if (depth === 0) {
    return view.measured.measure(element as Epoch);
  }

  const node = element as Node<unknown, unknown>;

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
  view: View<V>,
  digit: Digit<unknown>,
  cache: Cache<V>,
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
