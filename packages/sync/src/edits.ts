/**
 * Edits -- observes Y.Doc updates per channel,
 * wraps them as Edits, and routes them to the
 * Document's per-channel epoch trees.
 *
 * Start waits for SubdocProvider.whenLoaded to
 * avoid capturing hydration updates as new edits.
 * SNAPSHOT_ORIGIN and custom skipOrigins are
 * filtered.
 */
import type { SubdocProvider } from "./subdoc-provider.js";
import { SNAPSHOT_ORIGIN } from "./subdoc-provider.js";
import type { Document } from "@pokapali/document";
import { Edit, type EditOrigin } from "@pokapali/document";

/**
 * Bridge that captures Y.Doc updates and routes them
 * to Document channels as Edits.
 */
export interface Edits {
  readonly started: boolean;
  start(): Promise<void>;
  destroy(): void;
}

/**
 * Create an Edits instance.
 *
 * Does not start capturing until `start()` is called
 * and SubdocProvider.whenLoaded resolves.
 */
export const Edits: {
  create(opts: {
    subdocProvider: SubdocProvider;
    document: Document;
    channelNames: string[];
    localAuthor: string;
    skipOrigins?: Set<object>;
  }): Edits;
} = {
  create(opts) {
    const { subdocProvider, document, channelNames, localAuthor, skipOrigins } =
      opts;

    let started = false;
    let destroyed = false;
    const handlers = new Map<
      string,
      (update: Uint8Array, origin: unknown) => void
    >();

    function attach(): void {
      for (const name of channelNames) {
        const doc = subdocProvider.subdoc(name);
        const channel = document.channel(name);

        const handler = (update: Uint8Array, origin: unknown) => {
          if (destroyed) return;
          if (origin === SNAPSHOT_ORIGIN) return;
          if (skipOrigins && skipOrigins.has(origin as object)) {
            return;
          }

          const editOrigin: EditOrigin = origin == null ? "local" : "sync";

          channel.appendEdit(
            Edit.create({
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
        await subdocProvider.whenLoaded;
        if (destroyed) return;
        attach();
        started = true;
      },

      destroy() {
        destroyed = true;
        for (const name of channelNames) {
          const handler = handlers.get(name);
          if (handler) {
            const doc = subdocProvider.subdoc(name);
            doc.off("update", handler);
          }
        }
        handlers.clear();
      },
    };
  },
};
