/**
 * View types for the monoidal view system.
 *
 * A **MonoidalView** wraps a `Measured<V, Epoch>` with
 * metadata — it defines how to project epochs into a
 * monoidal summary and how to navigate the tree using
 * that summary.
 *
 * A **DerivedView** depends on other views' values at
 * tree positions. It takes resolved dependencies and
 * produces a derived value.
 *
 * **ViewState** tracks the lifecycle of a single view
 * evaluation: pending → computing → ready | stale.
 */
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "../epoch/types.js";
import type { EpochTree } from "../epoch/tree.js";

// -------------------------------------------------
// MonoidalView
// -------------------------------------------------

/**
 * A monoidal view over the epoch tree.
 *
 * Wraps a `Measured<V, Epoch>` (monoid + projection)
 * with human-readable metadata. The finger tree uses
 * the `measured` field to cache summaries at internal
 * nodes.
 */
export interface MonoidalView<V> {
  readonly name: string;
  readonly description: string;
  readonly measured: Measured<V, Epoch>;
}

/**
 * Construct a MonoidalView.
 */
export function monoidalView<V>(fields: {
  name: string;
  description: string;
  measured: Measured<V, Epoch>;
}): MonoidalView<V> {
  return { ...fields };
}

// -------------------------------------------------
// DerivedView
// -------------------------------------------------

/**
 * A view that depends on other views' resolved values.
 *
 * `Deps` is an object type mapping dependency names to
 * their value types. The `compute` function receives
 * the tree and resolved dependency values, producing
 * the derived value.
 */
export interface DerivedView<V, Deps extends object> {
  readonly name: string;
  readonly description: string;
  readonly compute: (tree: EpochTree, deps: Deps) => V;
}

// -------------------------------------------------
// ViewState
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
export type ViewState<V> =
  | { readonly tag: "pending" }
  | { readonly tag: "computing" }
  | { readonly tag: "ready"; readonly value: V }
  | { readonly tag: "stale"; readonly lastValue: V };

/** Construct a pending ViewState. */
export function viewPending<V>(): ViewState<V> {
  return { tag: "pending" };
}

/** Construct a computing ViewState. */
export function viewComputing<V>(): ViewState<V> {
  return { tag: "computing" };
}

/** Construct a ready ViewState. */
export function viewReady<V>(value: V): ViewState<V> {
  return { tag: "ready", value };
}

/** Construct a stale ViewState. */
export function viewStale<V>(lastValue: V): ViewState<V> {
  return { tag: "stale", lastValue };
}
