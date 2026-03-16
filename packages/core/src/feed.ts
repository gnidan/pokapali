/**
 * feed.ts — Reactive value container compatible with
 * React's useSyncExternalStore.
 *
 * Generic, reusable, no domain dependencies.
 */

/**
 * Read-only reactive value container compatible with
 * React's useSyncExternalStore.
 */
export interface Feed<T> {
  /** Current value. */
  getSnapshot(): T;
  /** Subscribe to changes. Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
}

/**
 * Internal writable feed. Extends Feed with an
 * _update method for the scan pipeline. Not exported
 * from the package public API.
 */
export interface WritableFeed<T> extends Feed<T> {
  /** Update the value. No-op if equal. */
  _update(value: T): void;
}

/**
 * Create a WritableFeed with an initial value and
 * optional equality function (defaults to ===).
 */
export function createFeed<T>(
  initial: T,
  eq?: (a: T, b: T) => boolean,
): WritableFeed<T> {
  let current = initial;
  const subs = new Set<() => void>();
  const equal = eq ?? ((a, b) => a === b);

  return {
    getSnapshot: () => current,
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    _update(value) {
      if (equal(current, value)) return;
      current = value;
      for (const cb of subs) cb();
    },
  };
}
