/**
 * Channel — mutable per-channel epoch tree.
 *
 * Wraps an immutable EpochTree (persistent finger tree)
 * with a mutable reference. Mutations produce new trees
 * via finger-tree ops (viewr, snoc) and notify the
 * internal ViewRegistry.
 *
 * Data flow:
 *   appendEdit → tip epoch → append → init + snoc
 *     → new tree → registry.notifyTreeChanged
 *   closeEpoch → tip epoch → close → init + snoc
 *     + snoc new empty open → registry.notifyTreeChanged
 */
import type { Feed } from "../feed.js";
import { snoc, viewr } from "@pokapali/finger-tree";
import { epochMeasured } from "../epoch/index-monoid.js";
import type { EpochTree } from "../epoch/tree.js";
import { fromEpochs } from "../epoch/tree.js";
import {
  epoch,
  openBoundary,
  appendEdit as epochAppendEdit,
  closeEpoch as epochCloseEpoch,
} from "../epoch/types.js";
import type { Edit } from "../epoch/types.js";
import type { MonoidalView } from "../view/types.js";
import type { ViewState } from "../view/types.js";
import { createViewRegistry } from "../view/registry.js";
import type { ViewRegistry } from "../view/registry.js";

/**
 * A mutable channel holding a per-channel epoch tree.
 */
export interface Channel {
  readonly name: string;
  readonly tree: EpochTree;
  appendEdit(edit: Edit): void;
  closeEpoch(): void;
  activate<V>(view: MonoidalView<V>): Feed<ViewState<V>>;
  deactivate(viewName: string): void;
  destroy(): void;
}

/**
 * Create a channel with a single empty open epoch.
 */
export function createChannel(name: string): Channel {
  const initialTree = fromEpochs([epoch([], openBoundary())]);

  let tree: EpochTree = initialTree;
  const registry: ViewRegistry = createViewRegistry(tree);
  let destroyed = false;

  function updateTree(newTree: EpochTree): void {
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
      // viewr gives { init, last } — last is tip epoch
      const v = viewr(epochMeasured, tree);
      if (!v) return; // shouldn't happen — always ≥ 1
      const newTip = epochAppendEdit(v.last, edit);
      updateTree(snoc(epochMeasured, v.init, newTip));
    },

    closeEpoch() {
      const v = viewr(epochMeasured, tree);
      if (!v) return;
      const closed = epochCloseEpoch(v.last);
      const withClosed = snoc(epochMeasured, v.init, closed);
      updateTree(snoc(epochMeasured, withClosed, epoch([], openBoundary())));
    },

    activate<V>(view: MonoidalView<V>): Feed<ViewState<V>> {
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
}
