/**
 * version-cache.ts — IDB persistence for the version
 * history index (which CIDs exist, seq, ts).
 *
 * Separate from BlockResolver (which caches block
 * bytes). This caches the metadata so browsers know
 * what versions exist on reload without hitting the
 * network.
 */

import { createLogger } from "@pokapali/log";

const log = createLogger("version-cache");

const DB_NAME = "pokapali:doc-cache";
const STORE_NAME = "version-index";
const DB_VERSION = 1;

export interface CachedVersionEntry {
  /** CID as string (serializable). */
  cid: string;
  seq: number;
  ts: number;
}

export interface VersionCacheData {
  ipnsName: string;
  entries: CachedVersionEntry[];
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: "ipnsName",
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Read cached version index for a doc.
 * Returns null on miss or IDB error.
 */
export async function readVersionCache(
  ipnsName: string,
): Promise<VersionCacheData | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ipnsName);
      req.onsuccess = () => {
        db.close();
        const data = req.result as VersionCacheData | undefined;
        resolve(data ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch (err) {
    log.debug("readVersionCache failed:", err);
    return null;
  }
}

/**
 * Write version index to IDB. Overwrites any
 * existing entry for this ipnsName.
 */
export async function writeVersionCache(
  ipnsName: string,
  entries: CachedVersionEntry[],
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const data: VersionCacheData = {
        ipnsName,
        entries,
        updatedAt: Date.now(),
      };
      store.put(data);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (err) {
    log.debug("writeVersionCache failed:", err);
  }
}
