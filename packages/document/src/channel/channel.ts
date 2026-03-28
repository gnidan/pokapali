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
import type { History } from "#history";
import {
  epochMeasured,
  History as HistoryCompanion,
  Edit,
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
  /**
   * Record a remote snapshot in the epoch tree.
   *
   * Closes the current epoch, appends a closed
   * epoch with a synthetic edit whose payload is
   * the full snapshot state, then opens a fresh
   * epoch for future edits.
   */
  appendSnapshot(state: Uint8Array): void;
  /** @internal Called by Document — use Document.activate instead. */
  activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe">;
  /** @internal Called by Document — use Document.deactivate instead. */
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

      appendSnapshot(state: Uint8Array) {
        // 1. Close current open epoch
        const v1 = viewr(epochMeasured, tree);
        if (!v1) return;
        const closed = Epoch.close(v1.last);
        const afterClose = snoc(epochMeasured, v1.init, closed);

        // 2. Append closed epoch with synthetic
        //    edit carrying the full snapshot state
        const syntheticEdit = Edit.create({
          payload: state,
          timestamp: Date.now(),
          author: "snapshot",
          channel: name,
          origin: "hydrate",
          signature: new Uint8Array(),
        });
        const snapshotEpoch = Epoch.create([syntheticEdit], Boundary.closed());
        const afterSnapshot = snoc(epochMeasured, afterClose, snapshotEpoch);

        // 3. Open fresh epoch for future edits
        updateTree(
          snoc(epochMeasured, afterSnapshot, Epoch.create([], Boundary.open())),
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
