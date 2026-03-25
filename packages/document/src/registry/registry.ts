/**
 * Registry — manages active monoidal view feeds.
 *
 * Tracks which views are active, creates/destroys
 * their Feeds, and propagates tree changes to all
 * active feeds.
 */
import type { View, Status } from "../view.js";
import type { Feed } from "../feed/feed.js";
import { Feed as FeedCompanion } from "../feed/feed.js";
import type { History } from "#history";

/**
 * Registry for active monoidal view feeds.
 */
export interface Registry {
  /** Activate a view, returning its feed. Idempotent. */
  activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe">;
  /** Deactivate a view by name. */
  deactivate(viewName: string): void;
  /** Check if a view is active. */
  isActive(viewName: string): boolean;
  /** Propagate a tree change to all active feeds. */
  notifyTreeChanged(tree: History): void;
  /** Destroy all active feeds. */
  destroy(): void;
}

/**
 * Companion object for the Registry type.
 */
export const Registry = {
  /**
   * Create a Registry with an initial history tree.
   */
  create(initialTree: History): Registry {
    let currentTree = initialTree;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feeds = new Map<string, Feed<any>>();

    return {
      activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe"> {
        const existing = feeds.get(view.name);
        if (existing) {
          return existing as Feed<V>;
        }

        const feed = FeedCompanion.create(view, currentTree);
        feeds.set(view.name, feed);
        return feed;
      },

      deactivate(viewName) {
        const feed = feeds.get(viewName);
        if (feed) {
          feed.destroy();
          feeds.delete(viewName);
        }
      },

      isActive(viewName) {
        return feeds.has(viewName);
      },

      notifyTreeChanged(tree) {
        currentTree = tree;
        for (const feed of feeds.values()) {
          feed.update(tree);
        }
      },

      destroy() {
        for (const feed of feeds.values()) {
          feed.destroy();
        }
        feeds.clear();
      },
    };
  },
};
