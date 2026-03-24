/**
 * EditBridge — observes SubdocManager Y.Doc updates,
 * wraps them as Edits, and routes them to the
 * Document's per-channel epoch trees.
 *
 * Start waits for SubdocManager.whenLoaded to avoid
 * capturing y-indexeddb hydration updates as new edits.
 * SNAPSHOT_ORIGIN and custom skipOrigins are filtered.
 */
import type { SubdocManager } from "@pokapali/subdocs";
import { SNAPSHOT_ORIGIN } from "@pokapali/subdocs";
import type { Document } from "../document/document.js";
import { edit } from "../epoch/types.js";
import type { EditOrigin } from "../epoch/types.js";

/**
 * Bridge that captures Y.Doc updates and routes them
 * to Document channels as Edits.
 */
export interface EditBridge {
  readonly started: boolean;
  start(): Promise<void>;
  destroy(): void;
}

/**
 * Create an EditBridge.
 *
 * Does not start capturing until `start()` is called
 * and SubdocManager.whenLoaded resolves.
 */
export function createEditBridge(opts: {
  subdocManager: SubdocManager;
  document: Document;
  channelNames: string[];
  localAuthor: string;
  skipOrigins?: Set<object>;
}): EditBridge {
  const { subdocManager, document, channelNames, localAuthor, skipOrigins } =
    opts;

  let started = false;
  let destroyed = false;
  const handlers = new Map<
    string,
    (update: Uint8Array, origin: unknown) => void
  >();

  function attach(): void {
    for (const name of channelNames) {
      const doc = subdocManager.subdoc(name);
      const channel = document.channel(name);

      const handler = (update: Uint8Array, origin: unknown) => {
        if (destroyed) return;
        if (origin === SNAPSHOT_ORIGIN) return;
        if (skipOrigins && skipOrigins.has(origin as object)) {
          return;
        }

        const editOrigin: EditOrigin = origin == null ? "local" : "sync";

        channel.appendEdit(
          edit({
            payload: update,
            timestamp: Date.now(),
            author: editOrigin === "local" ? localAuthor : "",
            channel: name,
            origin: editOrigin,
            signature: new Uint8Array([]),
          }),
        );
      };

      doc.on("update", handler);
      handlers.set(name, handler);
    }
  }

  return {
    get started() {
      return started;
    },

    async start() {
      if (started || destroyed) return;
      await subdocManager.whenLoaded;
      if (destroyed) return;
      attach();
      started = true;
    },

    destroy() {
      destroyed = true;
      for (const name of channelNames) {
        const handler = handlers.get(name);
        if (handler) {
          const doc = subdocManager.subdoc(name);
          doc.off("update", handler);
        }
      }
      handlers.clear();
    },
  };
}
