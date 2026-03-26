/**
 * view-cache.ts — IDB persistence for view cache
 * entries (monoid results per epoch).
 *
 * Separate database from the edit/epoch store to
 * avoid version migration coupling.
 *
 * Key: [viewName, channel, epochOrdinal]
 * Value: Uint8Array (serialized monoid result)
 */

const DB_VERSION = 1;
const STORE_NAME = "view-cache";

interface StoredViewCache {
  viewName: string;
  channel: string;
  epochOrdinal: number;
  data: Uint8Array;
}

export interface ViewCacheEntry {
  channel: string;
  epochOrdinal: number;
  data: Uint8Array;
}

export interface ViewCacheStore {
  read(
    viewName: string,
    channel: string,
    epochOrdinal: number,
  ): Promise<Uint8Array | null>;

  write(
    viewName: string,
    channel: string,
    epochOrdinal: number,
    data: Uint8Array,
  ): Promise<void>;

  loadAll(viewName: string): Promise<ViewCacheEntry[]>;

  destroy(): void;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: ["viewName", "channel", "epochOrdinal"],
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const ViewCacheStore: {
  create(dbName: string): Promise<ViewCacheStore>;
} = {
  async create(dbName: string): Promise<ViewCacheStore> {
    const db = await openDb(dbName);

    return {
      async read(
        viewName: string,
        channel: string,
        epochOrdinal: number,
      ): Promise<Uint8Array | null> {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const req = store.get([viewName, channel, epochOrdinal]);
          req.onsuccess = () => {
            const result = req.result as StoredViewCache | undefined;
            resolve(result?.data ?? null);
          };
          req.onerror = () => reject(req.error);
        });
      },

      async write(
        viewName: string,
        channel: string,
        epochOrdinal: number,
        data: Uint8Array,
      ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const stored: StoredViewCache = {
            viewName,
            channel,
            epochOrdinal,
            data,
          };
          store.put(stored);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },

      async loadAll(viewName: string): Promise<ViewCacheEntry[]> {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const range = IDBKeyRange.bound(
            [viewName, "", 0],
            [viewName, "\uffff", Number.MAX_SAFE_INTEGER],
          );
          const req = store.getAll(range);
          req.onsuccess = () => {
            const all = req.result as StoredViewCache[];
            resolve(
              all.map((s) => ({
                channel: s.channel,
                epochOrdinal: s.epochOrdinal,
                data: s.data,
              })),
            );
          };
          req.onerror = () => reject(req.error);
        });
      },

      destroy() {
        db.close();
      },
    };
  },
};
