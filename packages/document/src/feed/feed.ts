/**
 * Feed — reactive view evaluation container.
 *
 * Wraps monoidal view evaluation behind a reactive
 * interface compatible with React's
 * useSyncExternalStore.
 *
 * `update(tree)` triggers the lifecycle:
 *   stale(lastValue) → ready(newValue)
 *
 * Evaluation is synchronous. The internal Cache is
 * reused across updates for structural sharing.
 */
import type { View, Status, Cache } from "../view.js";
import {
  Status as StatusCompanion,
  Cache as CacheCompanion,
  inspect,
} from "../view.js";
import type { History } from "#history";

/**
 * A reactive feed for a monoidal view evaluation.
 *
 * Provides getSnapshot/subscribe for React compat,
 * plus update(tree) and destroy().
 */
export interface Feed<V> {
  /** Current status. */
  getSnapshot(): Status<V>;
  /** Subscribe to changes. Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Re-evaluate with a new tree. */
  update(tree: History): void;
  /** Stop all future notifications. */
  destroy(): void;
}

/**
 * Companion object for the Feed type.
 */
export const Feed = {
  /**
   * Create a Feed for a monoidal view.
   *
   * Immediately evaluates the view on the given tree
   * (pending → ready). Maintains an internal Cache
   * that persists across updates for structural
   * sharing.
   */
  create<V>(view: View<V>, tree: History): Feed<V> {
    const cache: Cache<V> = CacheCompanion.create();
    const subs = new Set<() => void>();
    let destroyed = false;

    const initial = inspect(view, tree, cache);
    let state: Status<V> = StatusCompanion.ready(initial);

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

        const lastValue =
          state.tag === "ready"
            ? state.value
            : state.tag === "stale"
              ? state.lastValue
              : undefined;

        if (lastValue !== undefined) {
          state = StatusCompanion.stale(lastValue);
          notify();
        }

        const value = inspect(view, newTree, cache);
        state = StatusCompanion.ready(value);
        notify();
      },

      destroy() {
        destroyed = true;
        subs.clear();
      },
    };
  },
};
