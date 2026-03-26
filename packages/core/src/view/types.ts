/**
 * Re-export view types from @pokapali/document
 * for backwards compatibility.
 */
import type { History } from "@pokapali/document";
import { View, Status } from "@pokapali/document";

export type MonoidalView<V> = View<V>;
export const monoidalView = View.singleChannel;

/**
 * A view that depends on other views' resolved values.
 *
 * Kept in core — not moved to document because
 * DerivedView was removed from the new API.
 */
export interface DerivedView<V, Deps extends object> {
  readonly name: string;
  readonly description: string;
  readonly compute: (tree: History, deps: Deps) => V;
}

export type ViewState<V> = Status<V>;
export const viewPending = Status.pending;
export const viewComputing = Status.computing;
export const viewReady = Status.ready;
export const viewStale = Status.stale;
