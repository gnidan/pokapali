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
 * **foldTree** evaluates a Measured over a History tree,
 * optionally at a prefix position.
 */
import type { Measured, FingerTree, Node, Digit } from "@pokapali/finger-tree";
import { split } from "@pokapali/finger-tree";
import { epochMeasured } from "./history/summary.js";
import type { Epoch } from "./history/epoch.js";
import type { History } from "./history/history.js";

// -------------------------------------------------
// View (formerly MonoidalView)
// -------------------------------------------------

/**
 * A document-level monoidal view.
 *
 * Maps channel names to `Measured<any, Epoch>` folds,
 * then combines per-channel results into a final value
 * of type `V`.
 */
export interface View<V> {
  readonly name: string;
  readonly description: string;
  readonly channels: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly [name: string]: Measured<any, Epoch>;
  };
  readonly combine: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: Readonly<Record<string, any>>,
  ) => V;
}

/**
 * Companion object for the View type.
 */
export const View = {
  /**
   * Construct a multi-channel View.
   */
  create<V>(fields: {
    name: string;
    description: string;
    channels: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly [name: string]: Measured<any, Epoch>;
    };
    combine: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results: Readonly<Record<string, any>>,
    ) => V;
  }): View<V> {
    return { ...fields };
  },

  /**
   * Construct a single-channel View.
   *
   * Wraps a `(channel, measured)` pair into a View
   * whose `combine` simply returns the channel's
   * result.
   */
  singleChannel<V>(fields: {
    name: string;
    description: string;
    channel: string;
    measured: Measured<V, Epoch>;
  }): View<V> {
    const { name, description, channel, measured } = fields;
    return {
      name,
      description,
      channels: { [channel]: measured },
      combine: (results) => results[channel] as V,
    };
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
// foldTree (tree-level fold, formerly inspect)
// -------------------------------------------------

/**
 * Fold a `Measured<V, Epoch>` over a History tree.
 *
 * This is a tree-level operation — it folds the tree
 * using the monoid. For document-level evaluation
 * across channels, callers extract per-channel
 * Measured from `View.channels`.
 *
 * Without options, folds the full tree.
 * With `{ at: n }`, folds over the first `n` epochs
 * (prefix evaluation).
 *
 * @param measured Monoid + measure function
 * @param tree     The history tree
 * @param cache    WeakMap cache for memoization
 * @param opts     Optional `{ at: number }` for prefix
 * @returns The folded monoidal value
 */
export function foldTree<V>(
  measured: Measured<V, Epoch>,
  tree: History,
  cache: Cache<V>,
  opts?: { at: number },
): V {
  if (opts !== undefined) {
    return foldTreeAt(measured, tree, opts.at, cache);
  }
  return walkTree(measured, tree, cache, 0);
}

function foldTreeAt<V>(
  measured: Measured<V, Epoch>,
  tree: History,
  position: number,
  cache: Cache<V>,
): V {
  const { monoid, measure } = measured;

  if (position <= 0) {
    return monoid.empty;
  }

  const s = split(epochMeasured, (v) => v.epochCount >= position, tree);

  if (!s) {
    return foldTree(measured, tree, cache);
  }

  const leftValue = foldTree(measured, s.left, cache);
  return monoid.append(leftValue, measure(s.value));
}

// -------------------------------------------------
// Tree walking (depth-tracked)
// -------------------------------------------------

function walkTree<V>(
  measured: Measured<V, Epoch>,
  tree: FingerTree<unknown, unknown>,
  cache: Cache<V>,
  depth: number,
): V {
  const { monoid } = measured;

  switch (tree.tag) {
    case "empty":
      return monoid.empty;

    case "single":
      return walkElement(measured, tree.a, cache, depth);

    case "deep": {
      const cached = cache.get(tree);
      if (cached !== undefined) return cached;

      const prefix = walkDigit(measured, tree.prefix, cache, depth);
      const middle = walkTree(measured, tree.middle, cache, depth + 1);
      const suffix = walkDigit(measured, tree.suffix, cache, depth);

      const result = monoid.append(monoid.append(prefix, middle), suffix);
      cache.set(tree, result);
      return result;
    }
  }
}

function walkElement<V>(
  measured: Measured<V, Epoch>,
  element: unknown,
  cache: Cache<V>,
  depth: number,
): V {
  if (depth === 0) {
    return measured.measure(element as Epoch);
  }

  const node = element as Node<unknown, unknown>;

  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const { monoid } = measured;
  let result: V;

  switch (node.tag) {
    case "node2":
      result = monoid.append(
        walkElement(measured, node.a, cache, depth - 1),
        walkElement(measured, node.b, cache, depth - 1),
      );
      break;
    case "node3":
      result = monoid.append(
        monoid.append(
          walkElement(measured, node.a, cache, depth - 1),
          walkElement(measured, node.b, cache, depth - 1),
        ),
        walkElement(measured, node.c, cache, depth - 1),
      );
      break;
  }

  cache.set(node, result);
  return result;
}

function walkDigit<V>(
  measured: Measured<V, Epoch>,
  digit: Digit<unknown>,
  cache: Cache<V>,
  depth: number,
): V {
  const { monoid } = measured;

  switch (digit.tag) {
    case "one":
      return walkElement(measured, digit.a, cache, depth);
    case "two":
      return monoid.append(
        walkElement(measured, digit.a, cache, depth),
        walkElement(measured, digit.b, cache, depth),
      );
    case "three":
      return monoid.append(
        monoid.append(
          walkElement(measured, digit.a, cache, depth),
          walkElement(measured, digit.b, cache, depth),
        ),
        walkElement(measured, digit.c, cache, depth),
      );
    case "four":
      return monoid.append(
        monoid.append(
          walkElement(measured, digit.a, cache, depth),
          walkElement(measured, digit.b, cache, depth),
        ),
        monoid.append(
          walkElement(measured, digit.c, cache, depth),
          walkElement(measured, digit.d, cache, depth),
        ),
      );
  }
}
