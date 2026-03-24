/**
 * ViewRegistry — manages active monoidal view feeds.
 *
 * Tracks which views are active, creates/destroys their
 * ViewFeeds, and propagates tree changes to all active
 * feeds.
 */
import type { Feed } from "../feed.js";
import type { MonoidalView } from "./types.js";
import type { ViewState } from "./types.js";
import type { EpochTree } from "../epoch/tree.js";
import type { ViewFeed } from "./view-feed.js";
import { createViewFeed } from "./view-feed.js";

/**
 * Registry for active monoidal view feeds.
 */
export interface ViewRegistry {
  /** Activate a view, returning its feed. Idempotent. */
  activate<V>(view: MonoidalView<V>): Feed<ViewState<V>>;
  /** Deactivate a view by name. */
  deactivate(viewName: string): void;
  /** Check if a view is active. */
  isActive(viewName: string): boolean;
  /** Propagate a tree change to all active feeds. */
  notifyTreeChanged(tree: EpochTree): void;
  /** Destroy all active feeds. */
  destroy(): void;
}

/**
 * Create a ViewRegistry with an initial epoch tree.
 */
export function createViewRegistry(initialTree: EpochTree): ViewRegistry {
  let currentTree = initialTree;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feeds = new Map<string, ViewFeed<any>>();

  return {
    activate<V>(view: MonoidalView<V>): Feed<ViewState<V>> {
      const existing = feeds.get(view.name);
      if (existing) {
        return existing as Feed<ViewState<V>>;
      }

      const feed = createViewFeed(view, currentTree);
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
}
