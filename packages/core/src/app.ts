/**
 * App — top-level application instance with document
 * registry and lifecycle management.
 *
 * Wraps the existing pokapali() entry point, adding
 * structured document tracking via a registry map.
 * New code alongside old — pokapali() is untouched.
 */

import { pokapali } from "./index.js";
import type { PokapaliConfig, PokapaliApp } from "./index.js";
import type { Doc } from "./create-doc.js";

export interface App {
  /** Application identifier. */
  readonly appId: string;
  /** Configured channels. */
  readonly channels: readonly string[];
  /** Base URL for capability links. */
  readonly origin: string;
  /** Live documents keyed by IPNS name. */
  readonly documents: ReadonlyMap<string, Doc>;
  /** Create a new document with admin access. */
  create(): Promise<Doc>;
  /** Open an existing document from a capability URL.
   *  Returns the existing Doc if already open — the
   *  first open's capability level wins (subsequent
   *  opens with different access levels are no-ops). */
  open(url: string): Promise<Doc>;
  /** Close a document by IPNS name, destroying it
   *  and removing it from the registry. */
  close(id: string): void;
  /** Check if a URL matches this app's doc format. */
  isDocUrl(url: string): boolean;
  /** Extract document IPNS name from a capability
   *  URL. */
  docIdFromUrl(url: string): string;
  /** Destroy all open documents and tear down the
   *  app. */
  destroy(): void;
}

export const App: {
  /** Async to allow future initialization work
   *  (identity loading, network bootstrap) without
   *  a breaking API change. Currently wraps the
   *  synchronous pokapali() call. */
  create(config: PokapaliConfig): Promise<App>;
} = {
  async create(config: PokapaliConfig): Promise<App> {
    const inner: PokapaliApp = pokapali(config);
    const docs = new Map<string, Doc>();

    const appId = config.appId ?? "";
    const channels = config.channels;
    const origin = config.origin;

    return {
      appId,
      channels,
      origin,
      documents: docs,

      async create(): Promise<Doc> {
        const doc = await inner.create();
        // Doc has an ipnsName on the params used
        // to create it. We need to extract the id.
        // The doc's read URL contains the IPNS name.
        const id = inner.docIdFromUrl(doc.urls.read);
        docs.set(id, doc);
        return doc;
      },

      async open(url: string): Promise<Doc> {
        const id = inner.docIdFromUrl(url);
        const existing = docs.get(id);
        if (existing) {
          return existing;
        }
        const doc = await inner.open(url);
        docs.set(id, doc);
        return doc;
      },

      close(id: string): void {
        const doc = docs.get(id);
        if (!doc) return;
        doc.destroy();
        docs.delete(id);
      },

      isDocUrl(url: string): boolean {
        return inner.isDocUrl(url);
      },

      docIdFromUrl(url: string): string {
        return inner.docIdFromUrl(url);
      },

      destroy(): void {
        for (const doc of docs.values()) {
          doc.destroy();
        }
        docs.clear();
      },
    };
  },
};
