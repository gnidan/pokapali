/**
 * Lightweight reactive Feed compatible with React's
 * useSyncExternalStore. Own implementation — does NOT
 * depend on @pokapali/core.
 */

export interface Feed<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): () => void;
}

export interface WritableFeed<T> extends Feed<T> {
  _update(value: T): void;
}

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
