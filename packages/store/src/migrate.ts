/**
 * On-open migration for the unified Store.
 *
 * Copies data from old per-concern IDB databases into
 * the unified `pokapali:{appId}` database. Each source
 * is tracked independently in the `meta` store so
 * partial failures (crash mid-migration) are recoverable
 * on the next open.
 *
 * Old databases are preserved read-only for a 2-week
 * safety window after migration.
 */

import { CID } from "multiformats/cid";

// -------------------------------------------------------
// Meta keys for migration tracking
// -------------------------------------------------------

const MIGRATION_IDENTITY = "migration:identity";
const MIGRATION_DOC_CACHE = "migration:doc-cache";

interface MigrationMeta {
  key: string;
  migratedAt: number;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function idbOpen(name: string, version?: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        // DB doesn't exist yet — abort and return null
        // so we don't create an empty database.
        req.transaction!.abort();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGetAll(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function metaGet(
  db: IDBDatabase,
  key: string,
): Promise<MigrationMeta | undefined> {
  return idbGet(db, "meta", key) as Promise<MigrationMeta | undefined>;
}

function metaSet(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    const record: MigrationMeta = {
      key,
      migratedAt: Date.now(),
    };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -------------------------------------------------------
// Identity migration
// -------------------------------------------------------

async function migrateIdentity(db: IDBDatabase, appId: string): Promise<void> {
  const done = await metaGet(db, MIGRATION_IDENTITY);
  if (done) return;

  const oldDbName = `pokapali:identity:${appId}`;
  const oldDb = await idbOpen(oldDbName, 1);
  if (!oldDb) {
    // No old DB — mark as migrated (nothing to do)
    await metaSet(db, MIGRATION_IDENTITY);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("keypair")) {
      await metaSet(db, MIGRATION_IDENTITY);
      return;
    }

    const record = (await idbGet(oldDb, "keypair", "device")) as
      | { seed: Uint8Array }
      | undefined;

    if (record?.seed) {
      // Copy seed to unified identities store
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("identities", "readwrite");
        const store = tx.objectStore("identities");
        // Only write if not already present (don't
        // overwrite identity set by new code path)
        const getReq = store.get("device");
        getReq.onsuccess = () => {
          if (!getReq.result) {
            store.put({ id: "device", seed: record.seed });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }
  } finally {
    oldDb.close();
  }

  await metaSet(db, MIGRATION_IDENTITY);
}

// -------------------------------------------------------
// Doc-cache → snapshots migration
// -------------------------------------------------------

interface OldVersionCacheData {
  ipnsName: string;
  entries: Array<{
    cid: string;
    seq: number;
    ts: number;
  }>;
  updatedAt: number;
}

async function migrateDocCache(db: IDBDatabase): Promise<void> {
  const done = await metaGet(db, MIGRATION_DOC_CACHE);
  if (done) return;

  const oldDb = await idbOpen("pokapali:doc-cache", 1);
  if (!oldDb) {
    await metaSet(db, MIGRATION_DOC_CACHE);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("version-index")) {
      await metaSet(db, MIGRATION_DOC_CACHE);
      return;
    }

    const all = (await idbGetAll(
      oldDb,
      "version-index",
    )) as OldVersionCacheData[];

    if (all.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("snapshots", "readwrite");
        const store = tx.objectStore("snapshots");

        for (const doc of all) {
          for (const entry of doc.entries) {
            let cidBytes: Uint8Array;
            try {
              cidBytes = CID.parse(entry.cid).bytes;
            } catch {
              // Skip unparseable CIDs
              continue;
            }

            // put() for idempotent upsert
            store.put({
              ipnsName: doc.ipnsName,
              cid: cidBytes,
              seq: entry.seq,
              ts: entry.ts,
              // TODO: placeholders until snapshot
              // metadata includes channel/epoch
              // provenance
              channel: "",
              epochIndex: 0,
            });
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } finally {
    oldDb.close();
  }

  await metaSet(db, MIGRATION_DOC_CACHE);
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Run all pending migrations. Called from Store.create
 * after the database is opened. Each migration is
 * idempotent and tracked independently.
 */
export async function runMigrations(
  db: IDBDatabase,
  appId: string,
): Promise<void> {
  await migrateIdentity(db, appId);
  await migrateDocCache(db);
}
