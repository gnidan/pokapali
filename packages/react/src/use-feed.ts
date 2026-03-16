import { useSyncExternalStore } from "react";
import type { Feed } from "@pokapali/core";

/**
 * Subscribe to a Feed<T> via useSyncExternalStore.
 * Re-renders when the feed emits a new snapshot.
 */
export function useFeed<T>(feed: Feed<T>): T {
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}
