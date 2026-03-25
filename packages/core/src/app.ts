/**
 * App — top-level application instance with document
 * registry and lifecycle management.
 *
 * Wraps the existing pokapali() entry point, adding
 * structured document tracking via a registry map
 * and per-document lifecycle state management.
 *
 * New code alongside old — pokapali() is untouched.
 */

import { pokapali } from "./index.js";
import type { PokapaliConfig, PokapaliApp } from "./index.js";
import type { Doc } from "./create-doc.js";
import type { Level } from "@pokapali/document";
import type { Codec } from "@pokapali/codec";
import { Document } from "@pokapali/document";

/** Extended config adding codec for view lifecycle. */
export interface AppConfig extends PokapaliConfig {
  /** Codec for CRDT operations. Required for
   *  lifecycle levels above background. */
  codec?: Codec;
}

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
  /** Activate views on a document up to the given
   *  lifecycle level. No-op for unknown doc IDs. */
  activate(id: string, level: Level): void;
  /** Deactivate all views on a document, returning
   *  it to background level. No-op for unknown
   *  doc IDs. */
  deactivate(id: string): void;
  /** Get the current lifecycle level for a document.
   *  Returns undefined for unknown doc IDs. */
  levelOf(id: string): Level | undefined;
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
  create(config: AppConfig): Promise<App>;
} = {
  async create(config: AppConfig): Promise<App> {
    const inner: PokapaliApp = pokapali(config);
    const docs = new Map<string, Doc>();
    const lifecycles = new Map<string, Document>();

    const appId = config.appId ?? "";
    const channels = config.channels;
    const origin = config.origin;
    const codec = config.codec;

    /** Minimal identity for Document — lifecycle
     *  management doesn't use identity or capability,
     *  but Document.create requires them. */
    const dummyIdentity = {
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    };

    const dummyCapability = {
      channels: new Set(channels),
      canPushSnapshots: false,
      isAdmin: false,
    };

    function createLifecycle(): Document {
      return Document.create({
        identity: dummyIdentity,
        capability: dummyCapability,
        codec,
      });
    }

    function registerDoc(id: string, doc: Doc): void {
      docs.set(id, doc);
      lifecycles.set(id, createLifecycle());
    }

    function removeDoc(id: string): void {
      const lc = lifecycles.get(id);
      if (lc) {
        lc.deactivate();
        lc.destroy();
      }
      lifecycles.delete(id);
      docs.delete(id);
    }

    return {
      appId,
      channels,
      origin,
      documents: docs,

      async create(): Promise<Doc> {
        const doc = await inner.create();
        const id = inner.docIdFromUrl(doc.urls.read);
        registerDoc(id, doc);
        return doc;
      },

      async open(url: string): Promise<Doc> {
        const id = inner.docIdFromUrl(url);
        const existing = docs.get(id);
        if (existing) {
          return existing;
        }
        const doc = await inner.open(url);
        registerDoc(id, doc);
        return doc;
      },

      close(id: string): void {
        const doc = docs.get(id);
        if (!doc) return;
        doc.destroy();
        removeDoc(id);
      },

      activate(id: string, level: Level): void {
        const lc = lifecycles.get(id);
        if (!lc) return;
        lc.activate(level);
      },

      deactivate(id: string): void {
        const lc = lifecycles.get(id);
        if (!lc) return;
        lc.deactivate();
      },

      levelOf(id: string): Level | undefined {
        const lc = lifecycles.get(id);
        return lc?.level;
      },

      isDocUrl(url: string): boolean {
        return inner.isDocUrl(url);
      },

      docIdFromUrl(url: string): string {
        return inner.docIdFromUrl(url);
      },

      destroy(): void {
        for (const [id] of docs) {
          const lc = lifecycles.get(id);
          if (lc) {
            lc.deactivate();
            lc.destroy();
          }
        }
        for (const doc of docs.values()) {
          doc.destroy();
        }
        docs.clear();
        lifecycles.clear();
      },
    };
  },
};
