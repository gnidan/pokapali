/**
 * Summary: cheap in-tree navigation index.
 *
 * The finger tree caches this at every internal node
 * for fast navigation. Computed eagerly and
 * synchronously on every append.
 *
 * Assembled via `combine` from small, independently
 * testable component monoids.
 */
import type { Monoid, Measured } from "@pokapali/finger-tree";
import { combine } from "@pokapali/finger-tree";
import type { Epoch } from "./epoch.js";

// -------------------------------------------------
// Summary (formerly EpochIndex)
// -------------------------------------------------

export interface Summary {
  readonly epochCount: number;
  readonly editCount: number;
  readonly timeRange: readonly [earliest: number, latest: number];
  readonly authors: ReadonlySet<string>;
  readonly snapshotCount: number;
}

/** @deprecated Use `Summary` instead. */
export type EpochIndex = Summary;

// -------------------------------------------------
// Component monoids (internal)
// -------------------------------------------------

/**
 * Sum monoid: identity 0, append adds.
 */
const Sum: Monoid<number> = {
  empty: 0,
  append: (a, b) => a + b,
};

/**
 * MinMax monoid over time ranges.
 *
 * Identity is [+Infinity, -Infinity] — the "nothing
 * seen yet" range. Append takes the min of firsts
 * and max of seconds.
 */
const MinMax: Monoid<readonly [number, number]> = {
  empty: [Infinity, -Infinity],
  append: (a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
};

/**
 * Set union monoid over author IDs (strings).
 *
 * Identity is the empty set. Append takes the union.
 */
const SetUnion: Monoid<ReadonlySet<string>> = {
  empty: new Set(),
  append: (a, b) => {
    if (a.size === 0) return b;
    if (b.size === 0) return a;
    const result = new Set(a);
    for (const x of b) result.add(x);
    return result;
  },
};

// Re-export for backwards compat from core shims
// and for tests that verify monoid laws directly
export { Sum, MinMax, SetUnion };

// -------------------------------------------------
// Product monoid via combine
// -------------------------------------------------

/**
 * The Summary monoid, assembled from components.
 */
export const summaryMonoid: Monoid<Summary> = combine<Summary>({
  epochCount: Sum,
  editCount: Sum,
  timeRange: MinMax,
  authors: SetUnion,
  snapshotCount: Sum,
});

/** @deprecated Use `summaryMonoid` instead. */
export const epochIndexMonoid: Monoid<Summary> = summaryMonoid;

// -------------------------------------------------
// Measured instance
// -------------------------------------------------

/**
 * Project a single Epoch into a Summary.
 */
function measureEpoch(ep: Epoch): Summary {
  const authors = new Set<string>();
  let earliest = Infinity;
  let latest = -Infinity;

  for (const e of ep.edits) {
    authors.add(e.author);
    if (e.timestamp < earliest) earliest = e.timestamp;
    if (e.timestamp > latest) latest = e.timestamp;
  }

  return {
    epochCount: 1,
    editCount: ep.edits.length,
    timeRange: [earliest, latest],
    authors,
    snapshotCount: ep.boundary.tag === "snapshotted" ? 1 : 0,
  };
}

/**
 * Measured instance for Epoch → Summary.
 *
 * Use this with FingerTree<Summary, Epoch>.
 */
export const epochMeasured: Measured<Summary, Epoch> = {
  monoid: summaryMonoid,
  measure: measureEpoch,
};

/**
 * Companion object for the Summary type.
 */
export const Summary = {
  /** The Summary monoid. */
  monoid: summaryMonoid,

  /** Measured instance for Epoch → Summary. */
  measured: epochMeasured,
};
