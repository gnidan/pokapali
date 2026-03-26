/**
 * projectFeed — derive a focused Feed from a broader
 * source Feed by selecting and deduplicating a
 * projected value.
 *
 * Subscribe to source, project via select, notify
 * only when eq says value changed.
 */
import type { Feed } from "./feed.js";

/**
 * Create a derived Feed that projects a value from
 * a source Feed. Subscribers are only notified when
 * the projected value changes according to eq
 * (defaults to ===).
 */
export function projectFeed<S, T>(
  source: Feed<S>,
  select: (state: S) => T,
  eq?: (a: T, b: T) => boolean,
): Feed<T> {
  const equal = eq ?? ((a, b) => a === b);
  let current = select(source.getSnapshot());

  const subs = new Set<() => void>();

  let sourceUnsub: (() => void) | null = null;

  function ensureSubscribed(): void {
    if (sourceUnsub) return;
    sourceUnsub = source.subscribe(() => {
      const next = select(source.getSnapshot());
      if (equal(current, next)) return;
      current = next;
      for (const cb of subs) cb();
    });
  }

  function maybeUnsubscribe(): void {
    if (subs.size === 0 && sourceUnsub) {
      sourceUnsub();
      sourceUnsub = null;
    }
  }

  return {
    getSnapshot() {
      // Always read fresh when no subscribers
      // (source may have changed)
      if (subs.size === 0) {
        current = select(source.getSnapshot());
      }
      return current;
    },
    subscribe(cb) {
      subs.add(cb);
      ensureSubscribed();
      return () => {
        subs.delete(cb);
        maybeUnsubscribe();
      };
    },
  };
}
