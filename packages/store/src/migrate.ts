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
import { createLogger } from "@pokapali/log";

const log = createLogger("store:migrate");

// -------------------------------------------------------
// Meta keys for migration tracking
// -------------------------------------------------------

const MIGRATION_IDENTITY = "migration:identity";
const MIGRATION_DOC_CACHE = "migration:doc-cache";
const MIGRATION_YINDEXEDDB = "migration:y-indexeddb";

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
// y-indexeddb → unified Store migration
// -------------------------------------------------------

/**
 * Parse a y-indexeddb database guid into ipnsName and
 * channel. Guids are formatted as `{ipnsName}:{channel}`
 * where ipnsName is a hex string and channel is a short
 * name like "content", "comments", or "_meta".
 */
function parseGuid(guid: string): {
  ipnsName: string;
  channel: string;
} | null {
  const idx = guid.lastIndexOf(":");
  if (idx <= 0) return null;
  return {
    ipnsName: guid.substring(0, idx),
    channel: guid.substring(idx + 1),
  };
}

/**
 * Discover old y-indexeddb database names. Uses
 * `indexedDB.databases()` (Chrome/Edge) where
 * available, falls back to deriving known guids from
 * the snapshots table.
 */
async function discoverYIndexeddbNames(
  db: IDBDatabase,
  appId: string,
): Promise<string[]> {
  // Try native enumeration first (Chrome, Edge)
  if (typeof indexedDB.databases === "function") {
    try {
      const all = await indexedDB.databases();
      // y-indexeddb names look like "{hex}:{channel}"
      // but NOT "pokapali:..." (our unified store).
      // Filter to hex:channel patterns.
      return all
        .map((d) => d.name ?? "")
        .filter((name) => {
          if (!name) return false;
          if (name.startsWith("pokapali:")) return false;
          const parsed = parseGuid(name);
          if (!parsed) return false;
          // Hex ipnsName is 64 chars
          return /^[0-9a-f]{64}$/.test(parsed.ipnsName);
        });
    } catch {
      // Fall through to snapshot-based discovery
    }
  }

  // Fallback: derive ipnsNames from snapshots table
  // (migrated from doc-cache in earlier migration).
  const ipnsNames = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction("snapshots", "readonly");
    const store = tx.objectStore("snapshots");
    const req = store.getAll();
    req.onsuccess = () => {
      const seen = new Set<string>();
      for (const snap of req.result as Array<{
        ipnsName: string;
      }>) {
        seen.add(snap.ipnsName);
      }
      resolve([...seen]);
    };
    req.onerror = () => reject(req.error);
  });

  // Try known channel names for each ipnsName
  const known = ["content", "comments", "_meta"];
  const names: string[] = [];
  for (const ipns of ipnsNames) {
    for (const ch of known) {
      names.push(`${ipns}:${ch}`);
    }
  }

  // Also try channel names from the app config by
  // checking if the database actually exists (via
  // idbOpen which aborts if DB doesn't exist).
  // The caller filters non-existent DBs anyway, so
  // false positives are harmless.
  return names;
}

/**
 * Find the latest snapshot CID for an ipnsName from
 * the snapshots table. Returns null if none found.
 */
function latestSnapshotCid(
  db: IDBDatabase,
  ipnsName: string,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", "readonly");
    const store = tx.objectStore("snapshots");
    const range = IDBKeyRange.bound(
      [ipnsName, 0],
      [ipnsName, Number.MAX_SAFE_INTEGER],
    );
    const req = store.getAll(range);
    req.onsuccess = () => {
      const snaps = req.result as Array<{
        cid: Uint8Array;
        seq: number;
      }>;
      if (snaps.length === 0) {
        resolve(null);
        return;
      }
      // Find highest seq
      let best = snaps[0]!;
      for (let i = 1; i < snaps.length; i++) {
        if (snaps[i]!.seq > best.seq) best = snaps[i]!;
      }
      resolve(best.cid);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Migrate a single y-indexeddb database into the
 * unified Store's edits table.
 */
async function migrateOneYIndexeddb(
  db: IDBDatabase,
  guid: string,
): Promise<void> {
  const metaKey = `y-indexeddb:${guid}`;
  const done = await metaGet(db, metaKey);
  if (done) return;

  const parsed = parseGuid(guid);
  if (!parsed) {
    await metaSet(db, metaKey);
    return;
  }

  const oldDb = await idbOpen(guid);
  if (!oldDb) {
    log.info(`${guid}: no old DB found, skipping`);
    await metaSet(db, metaKey);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("updates")) {
      log.info(`${guid}: no updates store, skipping`);
      await metaSet(db, metaKey);
      return;
    }

    const updates = await new Promise<Uint8Array[]>((resolve, reject) => {
      const tx = oldDb.transaction("updates", "readonly");
      const store = tx.objectStore("updates");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as Uint8Array[]);
      req.onerror = () => reject(req.error);
    });

    if (updates.length === 0) {
      log.info(`${guid}: 0 updates, skipping`);
      await metaSet(db, metaKey);
      return;
    }

    // Write all raw updates as StoredEdit records at
    // epoch 0 in a single transaction.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("edits", "readwrite");
      const store = tx.objectStore("edits");
      for (const payload of updates) {
        store.add({
          ipnsName: parsed.ipnsName,
          channel: parsed.channel,
          epochIndex: 0,
          payload,
          timestamp: 0,
          author: "",
          editChannel: parsed.channel,
          origin: "hydrate",
          signature: new Uint8Array(0),
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    log.info(`${guid}: migrated ${updates.length} updates`);

    // If a snapshot exists for this ipnsName and
    // this is NOT the _meta channel, close epoch 0
    // with a snapshotted boundary.
    if (parsed.channel !== "_meta") {
      const cidBytes = await latestSnapshotCid(db, parsed.ipnsName);
      if (cidBytes) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("epochs", "readwrite");
          const store = tx.objectStore("epochs");
          store.put({
            ipnsName: parsed.ipnsName,
            channel: parsed.channel,
            epochIndex: 0,
            boundary: {
              tag: "snapshotted",
              cidBytes,
            },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        const cid = CID.decode(cidBytes);
        log.info(
          `${guid}: closed epoch 0 with snapshot` +
            ` ${cid.toString().slice(0, 16)}...`,
        );
      }
    }
  } finally {
    oldDb.close();
  }

  await metaSet(db, metaKey);
}

/**
 * Migrate all old y-indexeddb databases into the
 * unified Store. Called once at Store.create time.
 *
 * y-indexeddb stores raw Yjs updates in an `updates`
 * object store with auto-increment keys. Each value
 * is a Uint8Array. We copy these raw bytes directly
 * into the edits table — no Y.Doc needed.
 *
 * Migration is tracked per guid in the meta store
 * (`y-indexeddb:{guid}`) and globally
 * (`migration:y-indexeddb` marks discovery complete).
 */
async function migrateYIndexeddb(
  db: IDBDatabase,
  appId: string,
): Promise<void> {
  const done = await metaGet(db, MIGRATION_YINDEXEDDB);
  if (done) return;

  try {
    const names = await discoverYIndexeddbNames(db, appId);
    if (names.length > 0) {
      log.info(
        `discovered ${names.length} y-indexeddb` + " databases to migrate",
      );
    }

    for (const guid of names) {
      try {
        await migrateOneYIndexeddb(db, guid);
      } catch (err) {
        log.warn(`y-indexeddb migration failed for` + ` ${guid}:`, err);
        // Continue with other databases — don't let
        // one failure block the rest.
      }
    }
  } catch (err) {
    log.warn("y-indexeddb discovery failed:", err);
  }

  await metaSet(db, MIGRATION_YINDEXEDDB);
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Run all pending migrations. Called from Store.create
 * after the database is opened. Each migration is
 * idempotent and tracked independently.
 *
 * Identity and doc-cache migrations are awaited (small,
 * needed immediately). y-indexeddb migration is returned
 * as a background promise — it discovers and migrates
 * ALL old databases app-wide without blocking startup.
 */
export async function runMigrations(
  db: IDBDatabase,
  appId: string,
): Promise<{ background: Promise<void> }> {
  await migrateIdentity(db, appId);
  await migrateDocCache(db);

  const background = migrateYIndexeddb(db, appId).catch((err) => {
    log.warn("y-indexeddb background migration failed:", err);
  });

  return { background };
}
