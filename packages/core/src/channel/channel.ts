/**
 * Re-export Channel from @pokapali/document
 * for backwards compatibility.
 */
import type { Feed } from "../feed.js";
import type { Channel as DocChannel, View, Status } from "@pokapali/document";
import { Channel as DocChannelCompanion } from "@pokapali/document";

export interface Channel {
  readonly name: string;
  readonly tree: DocChannel["tree"];
  appendEdit(edit: Parameters<DocChannel["appendEdit"]>[0]): void;
  closeEpoch(): void;
  activate<V>(view: View<V>): Feed<Status<V>>;
  deactivate(viewName: string): void;
  destroy(): void;
}

export function createChannel(name: string): Channel {
  const inner = DocChannelCompanion.create(name);

  return {
    get name() {
      return inner.name;
    },
    get tree() {
      return inner.tree;
    },
    appendEdit(edit) {
      inner.appendEdit(edit);
    },
    closeEpoch() {
      inner.closeEpoch();
    },
    activate<V>(view: View<V>): Feed<Status<V>> {
      const feed = inner.activate(view);
      return {
        getSnapshot: feed.getSnapshot,
        subscribe: feed.subscribe,
      };
    },
    deactivate(viewName) {
      inner.deactivate(viewName);
    },
    destroy() {
      inner.destroy();
    },
  };
}
