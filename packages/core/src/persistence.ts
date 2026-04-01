/**
 * IndexedDB persistence for Yjs docs.
 *
 * Layer A: y-indexeddb providers per Y.Doc.
 * Each provider auto-syncs Y.Doc state to IndexedDB
 * and restores it on load.
 *
 * The provider instance is used as the transaction
 * origin when applying stored updates, so it must be
 * added to Subdocs's skipOrigins to suppress
 * false dirty flags.
 */
import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";
import { createLogger } from "@pokapali/log";

const log = createLogger("persistence");

export interface DocPersistence {
  /** All providers' whenSynced promises. */
  readonly whenSynced: Promise<void>;
  /** Provider instances (for skipOrigins). */
  readonly providers: Set<IndexeddbPersistence>;
  /** Tear down all providers and close blockstore. */
  destroy(): void;
  /**
   * Optional callback to close the IDBBlockstore.
   * Set by the caller after construction since the
   * blockstore is created separately from the
   * y-indexeddb providers.
   */
  closeBlockstore?: () => Promise<void>;
}

/**
 * Attach y-indexeddb providers to a list of Y.Docs.
 * Each provider is keyed by the doc's guid
 * (which is `${ipnsName}:${namespace}`).
 *
 * Returns a DocPersistence handle for lifecycle
 * management. Call destroy() when the doc is closed.
 */
export function createDocPersistence(docs: Y.Doc[]): DocPersistence {
  const providers = new Set<IndexeddbPersistence>();

  for (const doc of docs) {
    const provider = new IndexeddbPersistence(doc.guid, doc);
    providers.add(provider);
  }

  const whenSynced = Promise.all([...providers].map((p) => p.whenSynced)).then(
    () => {},
  );

  const handle: DocPersistence = {
    whenSynced,
    providers,
    destroy() {
      for (const p of providers) {
        p.destroy();
      }
      providers.clear();
      handle.closeBlockstore?.().catch((err) => {
        log.debug("blockstore close error:", (err as Error)?.message ?? err);
      });
    },
  };
  return handle;
}
