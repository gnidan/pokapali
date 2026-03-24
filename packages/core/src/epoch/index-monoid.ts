/**
 * EpochIndex: cheap in-tree navigation index.
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
import type { Epoch } from "./types.js";

// -------------------------------------------------
// EpochIndex
// -------------------------------------------------

export interface EpochIndex {
  readonly epochCount: number;
  readonly editCount: number;
  readonly timeRange: readonly [earliest: number, latest: number];
  readonly authors: ReadonlySet<string>;
  readonly snapshotCount: number;
}

// -------------------------------------------------
// Component monoids
// -------------------------------------------------

/**
 * Sum monoid: identity 0, append adds.
 */
export const Sum: Monoid<number> = {
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
export const MinMax: Monoid<readonly [number, number]> = {
  empty: [Infinity, -Infinity],
  append: (a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
};

/**
 * Set union monoid over author IDs (strings).
 *
 * Identity is the empty set. Append takes the union.
 */
export const SetUnion: Monoid<ReadonlySet<string>> = {
  empty: new Set(),
  append: (a, b) => {
    if (a.size === 0) return b;
    if (b.size === 0) return a;
    const result = new Set(a);
    for (const x of b) result.add(x);
    return result;
  },
};

// -------------------------------------------------
// Product monoid via combine
// -------------------------------------------------

/**
 * The EpochIndex monoid, assembled from components.
 */
export const epochIndexMonoid: Monoid<EpochIndex> = combine<EpochIndex>({
  epochCount: Sum,
  editCount: Sum,
  timeRange: MinMax,
  authors: SetUnion,
  snapshotCount: Sum,
});

// -------------------------------------------------
// Measured instance
// -------------------------------------------------

/**
 * Project a single Epoch into an EpochIndex.
 */
function measureEpoch(ep: Epoch): EpochIndex {
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
 * Measured instance for Epoch → EpochIndex.
 *
 * Use this with FingerTree<EpochIndex, Epoch>.
 */
export const epochMeasured: Measured<EpochIndex, Epoch> = {
  monoid: epochIndexMonoid,
  measure: measureEpoch,
};
