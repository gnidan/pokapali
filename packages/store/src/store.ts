/**
 * Store — IDB persistence for epoch edits
 * and boundaries.
 *
 * Two object stores:
 * - `edits`: {channel, epochIndex, edit} with
 *   autoIncrement key, indexed by [channel, epochIndex]
 * - `epochs`: {channel, epochIndex, boundary} with
 *   keyPath [channel, epochIndex]
 *
 * `persistEdit` appends to the current (highest)
 * epoch index for that channel. `persistEpochBoundary`
 * records a boundary transition and advances the
 * epoch counter. `loadChannelEpochs` reconstructs
 * the full Epoch[] for a channel.
 */

import { CID } from "multiformats/cid";
import {
  type Edit,
  type Epoch,
  type EpochBoundary,
  Edit as EditCompanion,
  Epoch as EpochCompanion,
  Boundary,
} from "@pokapali/document";

const DB_VERSION = 1;
const EDITS_STORE = "edits";
const EPOCHS_STORE = "epochs";

interface StoredEdit {
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
  channel: string;
  epochIndex: number;
  boundary: {
    tag: "open" | "closed" | "snapshotted";
    cidBytes?: Uint8Array;
  };
}

export interface Store {
  persistEdit(channel: string, e: Edit): Promise<void>;
  persistEpochBoundary(
    channel: string,
    epochIndex: number,
    boundary: EpochBoundary,
  ): Promise<void>;
  loadChannelEpochs(channel: string): Promise<Epoch[]>;
  destroy(): void;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EDITS_STORE)) {
        const store = db.createObjectStore(EDITS_STORE, {
          autoIncrement: true,
        });
        store.createIndex("by-channel-epoch", ["channel", "epochIndex"]);
        store.createIndex("by-channel", ["channel"]);
      }
      if (!db.objectStoreNames.contains(EPOCHS_STORE)) {
        db.createObjectStore(EPOCHS_STORE, {
          keyPath: ["channel", "epochIndex"],
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get the current epoch index for a channel
 * (highest epochIndex with a boundary, or 0 if
 * none).
 */
function getCurrentEpochIndex(
  db: IDBDatabase,
  channel: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EPOCHS_STORE, "readonly");
    const store = tx.objectStore(EPOCHS_STORE);

    const range = IDBKeyRange.bound(
      [channel, 0],
      [channel, Number.MAX_SAFE_INTEGER],
    );
    const req = store.openCursor(range, "prev");

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const stored = cursor.value as StoredBoundary;
        resolve(stored.epochIndex + 1);
      } else {
        resolve(0);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export const Store: {
  create(dbName: string): Promise<Store>;
} = {
  async create(dbName: string): Promise<Store> {
    const db = await openDb(dbName);

    return {
      async persistEdit(channel: string, e: Edit): Promise<void> {
        const epochIndex = await getCurrentEpochIndex(db, channel);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(EDITS_STORE, "readwrite");
          const store = tx.objectStore(EDITS_STORE);
          const stored: StoredEdit = {
            channel,
            epochIndex,
            payload: e.payload,
            timestamp: e.timestamp,
            author: e.author,
            editChannel: e.channel,
            origin: e.origin,
            signature: e.signature,
          };
          store.add(stored);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },

      async persistEpochBoundary(
        channel: string,
        epochIndex: number,
        boundary: EpochBoundary,
      ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(EPOCHS_STORE, "readwrite");
          const store = tx.objectStore(EPOCHS_STORE);
          const stored: StoredBoundary = {
            channel,
            epochIndex,
            boundary: {
              tag: boundary.tag,
              ...(boundary.tag === "snapshotted"
                ? {
                    cidBytes: boundary.cid.bytes,
                  }
                : {}),
            },
          };
          store.put(stored);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },

      async loadChannelEpochs(channel: string): Promise<Epoch[]> {
        const boundaries = await new Promise<StoredBoundary[]>(
          (resolve, reject) => {
            const tx = db.transaction(EPOCHS_STORE, "readonly");
            const store = tx.objectStore(EPOCHS_STORE);
            const range = IDBKeyRange.bound(
              [channel, 0],
              [channel, Number.MAX_SAFE_INTEGER],
            );
            const req = store.getAll(range);
            req.onsuccess = () => resolve(req.result as StoredBoundary[]);
            req.onerror = () => reject(req.error);
          },
        );

        const edits = await new Promise<StoredEdit[]>((resolve, reject) => {
          const tx = db.transaction(EDITS_STORE, "readonly");
          const store = tx.objectStore(EDITS_STORE);
          const index = store.index("by-channel");
          const range = IDBKeyRange.only([channel]);
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

      destroy() {
        db.close();
      },
    };
  },
};
