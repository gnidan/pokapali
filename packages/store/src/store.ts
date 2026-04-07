/**
 * Store — unified IDB persistence for pokapali.
 *
 * Single database `pokapali:{appId}` with 6 object
 * stores: identities, edits, epochs, snapshots,
 * view-cache, meta.
 *
 * The Store interface is hierarchical:
 *   store.identity        — device key persistence
 *   store.documents       — lazy per-document handles
 *     .get(ipnsName)      — no IDB work until called
 *       .history(channel) — per-channel edit/epoch ops
 *       .snapshots        — per-document snapshot log
 *       .viewCache        — per-document view cache
 *
 * @module
 */

import { CID } from "multiformats/cid";
import { runMigrations } from "./migrate.js";
import {
  type Edit,
  type Epoch,
  type EpochBoundary,
  Edit as EditCompanion,
  Epoch as EpochCompanion,
  Boundary,
} from "@pokapali/document";

// -------------------------------------------------------
// Constants
// -------------------------------------------------------

const DB_VERSION = 2;

const IDENTITIES_STORE = "identities";
const EDITS_STORE = "edits";
const EPOCHS_STORE = "epochs";
const SNAPSHOTS_STORE = "snapshots";
const VIEW_CACHE_STORE = "view-cache";
const META_STORE = "meta";

// -------------------------------------------------------
// Stored record shapes
// -------------------------------------------------------

interface StoredEdit {
  ipnsName: string;
  channel: string;
  epochIndex: number;
  payload: Uint8Array;
  timestamp: number;
  author: string;
  editChannel: string;
  origin: "local" | "sync" | "hydrate";
  signature: Uint8Array;
}

interface StoredBoundary {
  ipnsName: string;
  channel: string;
  epochIndex: number;
  boundary: {
    tag: "open" | "closed" | "snapshotted";
    cidBytes?: Uint8Array;
  };
}

interface StoredSnapshot {
  ipnsName: string;
  cid: Uint8Array;
  seq: number;
  ts: number;
  channel: string;
  epochIndex: number;
}

interface StoredViewCache {
  ipnsName: string;
  viewName: string;
  channel: string;
  epochOrdinal: number;
  data: Uint8Array;
}

// -------------------------------------------------------
// Public types
// -------------------------------------------------------

export interface Store {
  identity: Store.Identity;
  documents: Store.Documents;
  /** Resolves when background migrations complete. */
  migrated: Promise<void>;
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Store {
  export interface Identity {
    load(id: string): Promise<Uint8Array | null>;
    save(id: string, seed: Uint8Array): Promise<void>;
  }

  export interface Documents {
    get(ipnsName: string): Store.Document;
  }

  export interface Document {
    history(channel: string): Document.History;
    snapshots: Document.Snapshots;
    viewCache: Document.ViewCache;
    destroy(): Promise<void>;
  }

  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Document {
    export interface History {
      append(epochIndex: number, edit: Edit): Promise<void>;
      close(epochIndex: number, boundary: EpochBoundary): Promise<void>;
      load(): Promise<Epoch[]>;
    }

    export interface Snapshot {
      cid: Uint8Array;
      seq: number;
      ts: number;
      channel: string;
      epochIndex: number;
    }

    export interface Snapshots {
      append(snapshot: Snapshot): Promise<void>;
      loadAll(): Promise<Snapshot[]>;
    }

    export interface ViewCache {
      load(
        viewName: string,
        channel: string,
        epochOrdinal: number,
      ): Promise<Uint8Array | null>;
      save(
        viewName: string,
        channel: string,
        epochOrdinal: number,
        data: Uint8Array,
      ): Promise<void>;
    }
  }
}

// -------------------------------------------------------
// IDB helpers
// -------------------------------------------------------

function openDb(appId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`pokapali:${appId}`, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(IDENTITIES_STORE)) {
        db.createObjectStore(IDENTITIES_STORE, {
          keyPath: "id",
        });
      }

      if (!db.objectStoreNames.contains(EDITS_STORE)) {
        const store = db.createObjectStore(EDITS_STORE, {
          autoIncrement: true,
        });
        store.createIndex("by-doc-channel-epoch", [
          "ipnsName",
          "channel",
          "epochIndex",
        ]);
        store.createIndex("by-doc-channel", ["ipnsName", "channel"]);
      }

      if (!db.objectStoreNames.contains(EPOCHS_STORE)) {
        db.createObjectStore(EPOCHS_STORE, {
          keyPath: ["ipnsName", "channel", "epochIndex"],
        });
      }

      if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        db.createObjectStore(SNAPSHOTS_STORE, {
          keyPath: ["ipnsName", "seq"],
        });
      }

      if (!db.objectStoreNames.contains(VIEW_CACHE_STORE)) {
        db.createObjectStore(VIEW_CACHE_STORE, {
          keyPath: ["ipnsName", "viewName", "channel", "epochOrdinal"],
        });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, {
          keyPath: "key",
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// -------------------------------------------------------
// Implementation
// -------------------------------------------------------

export const Store: {
  create(appId: string): Promise<Store>;
} = {
  async create(appId: string): Promise<Store> {
    const db = await openDb(appId);
    const { background } = await runMigrations(db, appId);

    const identity: Store.Identity = {
      async load(id: string): Promise<Uint8Array | null> {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(IDENTITIES_STORE, "readonly");
          const store = tx.objectStore(IDENTITIES_STORE);
          const req = store.get(id);
          req.onsuccess = () => {
            const result = req.result as
              | { id: string; seed: Uint8Array }
              | undefined;
            resolve(result?.seed ?? null);
          };
          req.onerror = () => reject(req.error);
        });
      },

      async save(id: string, seed: Uint8Array): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(IDENTITIES_STORE, "readwrite");
          const store = tx.objectStore(IDENTITIES_STORE);
          store.put({ id, seed });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    };

    const documents: Store.Documents = {
      get(ipnsName: string): Store.Document {
        return createDocumentHandle(db, ipnsName);
      },
    };

    return {
      identity,
      documents,
      migrated: background,
      close() {
        db.close();
      },
    };
  },
};

// -------------------------------------------------------
// Document handle (lazy — no IDB until methods called)
// -------------------------------------------------------

function createDocumentHandle(
  db: IDBDatabase,
  ipnsName: string,
): Store.Document {
  function history(channel: string): Store.Document.History {
    return {
      async append(epochIndex: number, edit: Edit): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(EDITS_STORE, "readwrite");
          const store = tx.objectStore(EDITS_STORE);
          const stored: StoredEdit = {
            ipnsName,
            channel,
            epochIndex,
            payload: edit.payload,
            timestamp: edit.timestamp,
            author: edit.author,
            editChannel: edit.channel,
            origin: edit.origin,
            signature: edit.signature,
          };
          store.add(stored);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },

      async close(epochIndex: number, boundary: EpochBoundary): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(EPOCHS_STORE, "readwrite");
          const store = tx.objectStore(EPOCHS_STORE);
          const stored: StoredBoundary = {
            ipnsName,
            channel,
            epochIndex,
            boundary: {
              tag: boundary.tag,
              ...(boundary.tag === "snapshotted"
                ? { cidBytes: boundary.cid.bytes }
                : {}),
            },
          };
          store.put(stored);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },

      async load(): Promise<Epoch[]> {
        const boundaries = await new Promise<StoredBoundary[]>(
          (resolve, reject) => {
            const tx = db.transaction(EPOCHS_STORE, "readonly");
            const store = tx.objectStore(EPOCHS_STORE);
            const range = IDBKeyRange.bound(
              [ipnsName, channel, 0],
              [ipnsName, channel, Number.MAX_SAFE_INTEGER],
            );
            const req = store.getAll(range);
            req.onsuccess = () => resolve(req.result as StoredBoundary[]);
            req.onerror = () => reject(req.error);
          },
        );

        const edits = await new Promise<StoredEdit[]>((resolve, reject) => {
          const tx = db.transaction(EDITS_STORE, "readonly");
          const store = tx.objectStore(EDITS_STORE);
          const index = store.index("by-doc-channel");
          const range = IDBKeyRange.only([ipnsName, channel]);
          const req = index.getAll(range);
          req.onsuccess = () => resolve(req.result as StoredEdit[]);
          req.onerror = () => reject(req.error);
        });

        if (edits.length === 0 && boundaries.length === 0) {
          return [];
        }

        const boundaryMap = new Map<number, EpochBoundary>();
        for (const b of boundaries) {
          if (b.boundary.tag === "snapshotted" && b.boundary.cidBytes) {
            const cid = CID.decode(b.boundary.cidBytes);
            boundaryMap.set(b.epochIndex, Boundary.snapshotted(cid));
          } else {
            boundaryMap.set(b.epochIndex, b.boundary as EpochBoundary);
          }
        }

        const editsByEpoch = new Map<number, Edit[]>();
        for (const stored of edits) {
          const e = EditCompanion.create({
            payload: stored.payload,
            timestamp: stored.timestamp,
            author: stored.author,
            channel: stored.editChannel,
            origin: stored.origin,
            signature: stored.signature,
          });
          const arr = editsByEpoch.get(stored.epochIndex) ?? [];
          arr.push(e);
          editsByEpoch.set(stored.epochIndex, arr);
        }

        let maxEpoch = 0;
        for (const b of boundaries) {
          maxEpoch = Math.max(maxEpoch, b.epochIndex);
        }
        for (const stored of edits) {
          maxEpoch = Math.max(maxEpoch, stored.epochIndex);
        }

        const result: Epoch[] = [];
        for (let i = 0; i <= maxEpoch; i++) {
          const epochEdits = editsByEpoch.get(i) ?? [];
          const boundary = boundaryMap.get(i) ?? Boundary.open();
          result.push(EpochCompanion.create(epochEdits, boundary));
        }

        if (
          result.length > 0 &&
          result[result.length - 1]!.boundary.tag !== "open"
        ) {
          result.push(EpochCompanion.create([], Boundary.open()));
        }

        return result;
      },
    };
  }

  const snapshots: Store.Document.Snapshots = {
    async append(snapshot: Store.Document.Snapshot): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SNAPSHOTS_STORE, "readwrite");
        const store = tx.objectStore(SNAPSHOTS_STORE);
        const stored: StoredSnapshot = {
          ipnsName,
          cid: snapshot.cid,
          seq: snapshot.seq,
          ts: snapshot.ts,
          channel: snapshot.channel,
          epochIndex: snapshot.epochIndex,
        };
        store.put(stored);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async loadAll(): Promise<Store.Document.Snapshot[]> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(SNAPSHOTS_STORE, "readonly");
        const store = tx.objectStore(SNAPSHOTS_STORE);
        const range = IDBKeyRange.bound(
          [ipnsName, 0],
          [ipnsName, Number.MAX_SAFE_INTEGER],
        );
        const req = store.getAll(range);
        req.onsuccess = () => {
          const all = req.result as StoredSnapshot[];
          resolve(
            all.map((s) => ({
              cid: s.cid,
              seq: s.seq,
              ts: s.ts,
              channel: s.channel,
              epochIndex: s.epochIndex,
            })),
          );
        };
        req.onerror = () => reject(req.error);
      });
    },
  };

  const viewCache: Store.Document.ViewCache = {
    async load(
      viewName: string,
      channel: string,
      epochOrdinal: number,
    ): Promise<Uint8Array | null> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIEW_CACHE_STORE, "readonly");
        const store = tx.objectStore(VIEW_CACHE_STORE);
        const req = store.get([ipnsName, viewName, channel, epochOrdinal]);
        req.onsuccess = () => {
          const result = req.result as StoredViewCache | undefined;
          resolve(result?.data ?? null);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async save(
      viewName: string,
      channel: string,
      epochOrdinal: number,
      data: Uint8Array,
    ): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VIEW_CACHE_STORE, "readwrite");
        const store = tx.objectStore(VIEW_CACHE_STORE);
        const stored: StoredViewCache = {
          ipnsName,
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
  };

  return {
    history,
    snapshots,
    viewCache,
    async destroy(): Promise<void> {
      // Delete all data for this document across all
      // stores. Uses cursor-based deletion for edits
      // (autoIncrement key) and range deletion for
      // stores with compound keyPaths.
      const stores = [
        EDITS_STORE,
        EPOCHS_STORE,
        SNAPSHOTS_STORE,
        VIEW_CACHE_STORE,
      ];
      const tx = db.transaction(stores, "readwrite");

      function cursorDelete(
        req: IDBRequest<IDBCursorWithValue | null>,
      ): Promise<void> {
        return new Promise((resolve, reject) => {
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => reject(req.error);
        });
      }

      const editsStore = tx.objectStore(EDITS_STORE);
      const editsIndex = editsStore.index("by-doc-channel");
      const epochsStore = tx.objectStore(EPOCHS_STORE);
      const snapshotsStore = tx.objectStore(SNAPSHOTS_STORE);
      const viewCacheStore = tx.objectStore(VIEW_CACHE_STORE);

      // Fire all cursor deletions concurrently within
      // the same transaction to avoid auto-commit.
      await Promise.all([
        cursorDelete(
          editsIndex.openCursor(
            IDBKeyRange.bound([ipnsName, ""], [ipnsName, "\uffff"]),
          ),
        ),
        cursorDelete(
          epochsStore.openCursor(
            IDBKeyRange.bound(
              [ipnsName, "", 0],
              [ipnsName, "\uffff", Number.MAX_SAFE_INTEGER],
            ),
          ),
        ),
        cursorDelete(
          snapshotsStore.openCursor(
            IDBKeyRange.bound(
              [ipnsName, 0],
              [ipnsName, Number.MAX_SAFE_INTEGER],
            ),
          ),
        ),
        cursorDelete(
          viewCacheStore.openCursor(
            IDBKeyRange.bound(
              [ipnsName, "", "", 0],
              [ipnsName, "\uffff", "\uffff", Number.MAX_SAFE_INTEGER],
            ),
          ),
        ),
      ]);

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
