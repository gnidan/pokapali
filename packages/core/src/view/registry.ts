/**
 * Re-export ViewRegistry from @pokapali/document
 * for backwards compatibility.
 */
import type { Feed } from "../feed.js";
import type { View, Status, History } from "@pokapali/document";
import { Registry } from "@pokapali/document";

export interface ViewRegistry {
  activate<V>(view: View<V>): Feed<Status<V>>;
  deactivate(viewName: string): void;
  isActive(viewName: string): boolean;
  notifyTreeChanged(tree: History): void;
  destroy(): void;
}

export function createViewRegistry(initialTree: History): ViewRegistry {
  const inner = Registry.create("content", initialTree);
  const wrappers = new Map<string, Feed<Status<unknown>>>();

  return {
    activate<V>(view: View<V>): Feed<Status<V>> {
      const existing = wrappers.get(view.name);
      if (existing) {
        return existing as Feed<Status<V>>;
      }

      const feed = inner.activate(view);
      const wrapper: Feed<Status<V>> = {
        getSnapshot: feed.getSnapshot,
        subscribe: feed.subscribe,
      };
      wrappers.set(view.name, wrapper as Feed<Status<unknown>>);
      return wrapper;
    },
    deactivate(viewName) {
      inner.deactivate(viewName);
      wrappers.delete(viewName);
    },
    isActive: (n) => inner.isActive(n),
    notifyTreeChanged: (t) => inner.notifyTreeChanged(t),
    destroy() {
      inner.destroy();
      wrappers.clear();
    },
  };
}
