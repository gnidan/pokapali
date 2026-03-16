import { useSyncExternalStore } from "react";
import type { Feed } from "@pokapali/core";

const noopSubscribe = () => () => {};
const noopSnapshot = () => undefined;

/**
 * Subscribe to a Feed<T> via useSyncExternalStore.
 * Re-renders when the feed emits a new snapshot.
 *
 * Accepts null/undefined for convenience — returns
 * undefined until a feed is available.
 */
export function useFeed<T>(feed: Feed<T>): T;
export function useFeed<T>(feed: Feed<T> | null | undefined): T | undefined;
export function useFeed<T>(feed: Feed<T> | null | undefined): T | undefined {
  return useSyncExternalStore(
    feed?.subscribe ?? noopSubscribe,
    feed?.getSnapshot ?? noopSnapshot,
  );
}
