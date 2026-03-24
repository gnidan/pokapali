/**
 * ViewFeed — reactive view evaluation container.
 *
 * Wraps monoidal view evaluation behind a Feed<ViewState<V>>
 * interface compatible with React's useSyncExternalStore.
 *
 * `update(tree)` triggers the lifecycle:
 *   stale(lastValue) → ready(newValue)
 *
 * Evaluation is synchronous. The internal ViewCache is
 * reused across updates for structural sharing.
 */
import type { Feed } from "../feed.js";
import type { MonoidalView } from "./types.js";
import type { ViewState } from "./types.js";
import { viewPending, viewReady, viewStale } from "./types.js";
import { evaluateMonoidal, createCache } from "./evaluate.js";
import type { ViewCache } from "./evaluate.js";
import type { EpochTree } from "../epoch/tree.js";

/**
 * A reactive feed for a monoidal view evaluation.
 *
 * Extends Feed<ViewState<V>> with:
 * - `update(tree)` — re-evaluate with new tree
 * - `destroy()` — stop all notifications
 */
export interface ViewFeed<V> extends Feed<ViewState<V>> {
  /** Re-evaluate with a new tree. */
  update(tree: EpochTree): void;
  /** Stop all future notifications. */
  destroy(): void;
}

/**
 * Create a ViewFeed for a monoidal view.
 *
 * Immediately evaluates the view on the given tree
 * (pending → ready). Maintains an internal ViewCache
 * that persists across updates for structural sharing.
 *
 * @param view  The monoidal view
 * @param tree  Initial epoch tree
 * @returns A ViewFeed in ready state
 */
export function createViewFeed<V>(
  view: MonoidalView<V>,
  tree: EpochTree,
): ViewFeed<V> {
  const cache: ViewCache<V> = createCache();
  const subs = new Set<() => void>();
  let destroyed = false;

  // Evaluate immediately
  const initial = evaluateMonoidal(view, tree, cache);
  let state: ViewState<V> = viewReady(initial);

  function notify(): void {
    if (destroyed) return;
    for (const cb of subs) cb();
  }

  return {
    getSnapshot: () => state,

    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },

    update(newTree) {
      if (destroyed) return;

      // Transition to stale with last value
      const lastValue =
        state.tag === "ready"
          ? state.value
          : state.tag === "stale"
            ? state.lastValue
            : undefined;

      if (lastValue !== undefined) {
        state = viewStale(lastValue);
        notify();
      }

      // Re-evaluate (sync) with shared cache
      const value = evaluateMonoidal(view, newTree, cache);
      state = viewReady(value);
      notify();
    },

    destroy() {
      destroyed = true;
      subs.clear();
    },
  };
}
