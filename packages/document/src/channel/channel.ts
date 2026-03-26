/**
 * Channel — mutable per-channel epoch tree.
 *
 * Wraps an immutable History (persistent finger tree)
 * with a mutable reference. Mutations produce new
 * trees via finger-tree ops (viewr, snoc) and notify
 * the internal Registry.
 *
 * Data flow:
 *   appendEdit → tip epoch → append → init + snoc
 *     → new tree → registry.notifyTreeChanged
 *   closeEpoch → tip epoch → close → init + snoc
 *     + snoc new empty open → registry.notifyTreeChanged
 */
import { snoc, viewr } from "@pokapali/finger-tree";
import type { History, Edit } from "#history";
import {
  epochMeasured,
  History as HistoryCompanion,
  Epoch,
  Boundary,
} from "#history";
import type { View } from "../view.js";
import type { Feed } from "../feed/feed.js";
import { Registry } from "../registry/registry.js";

/**
 * A mutable channel holding a per-channel epoch tree.
 */
export interface Channel {
  readonly name: string;
  readonly tree: History;
  appendEdit(edit: Edit): void;
  closeEpoch(): void;
  activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe">;
  deactivate(viewName: string): void;
  destroy(): void;
}

/**
 * Companion object for the Channel type.
 */
export const Channel = {
  /**
   * Create a channel with a single empty open epoch.
   */
  create(name: string): Channel {
    const initialTree = HistoryCompanion.fromEpochs([
      Epoch.create([], Boundary.open()),
    ]);

    let tree: History = initialTree;
    const registry = Registry.create(name, tree);
    let destroyed = false;

    function updateTree(newTree: History): void {
      tree = newTree;
      if (!destroyed) {
        registry.notifyTreeChanged(tree);
      }
    }

    return {
      get name() {
        return name;
      },

      get tree() {
        return tree;
      },

      appendEdit(edit: Edit) {
        const v = viewr(epochMeasured, tree);
        if (!v) return;
        const newTip = Epoch.append(v.last, edit);
        updateTree(snoc(epochMeasured, v.init, newTip));
      },

      closeEpoch() {
        const v = viewr(epochMeasured, tree);
        if (!v) return;
        const closed = Epoch.close(v.last);
        const withClosed = snoc(epochMeasured, v.init, closed);
        updateTree(
          snoc(epochMeasured, withClosed, Epoch.create([], Boundary.open())),
        );
      },

      activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe"> {
        return registry.activate(view);
      },

      deactivate(viewName: string) {
        registry.deactivate(viewName);
      },

      destroy() {
        destroyed = true;
        registry.destroy();
      },
    };
  },
};
