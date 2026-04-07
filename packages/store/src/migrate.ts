/**
 * On-open migration for the unified Store.
 *
 * Copies data from old per-concern IDB databases into
 * the unified `pokapali:{appId}` database.
 *
 * y-indexeddb migration uses per-edit `legacyId`
 * tracking: each migrated edit is tagged with
 * `{guid}:{autoIncrementKey}` in a sparse unique
 * index. This provides:
 *   - Idempotent insert (unique constraint)
 *   - Fast short-circuit (count match = skip)
 *   - Per-edit precision (partial = resume)
 *
 * Identity and doc-cache migrations use simple
 * boolean flags in the meta store (small, fast).
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

  log.info("identity: starting migration");

  const oldDbName = `pokapali:identity:${appId}`;
  const oldDb = await idbOpen(oldDbName, 1);
  if (!oldDb) {
    log.info("identity: no old DB, skipping");
    await metaSet(db, MIGRATION_IDENTITY);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("keypair")) {
      log.info("identity: no keypair store, skipping");
      await metaSet(db, MIGRATION_IDENTITY);
      return;
    }

    const record = (await idbGet(oldDb, "keypair", "device")) as
      | { seed: Uint8Array }
      | undefined;

    if (record?.seed) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("identities", "readwrite");
        const store = tx.objectStore("identities");
        const getReq = store.get("device");
        getReq.onsuccess = () => {
          if (!getReq.result) {
            store.put({
              id: "device",
              seed: record.seed,
            });
            log.info("identity: migrated device seed");
          } else {
            log.info("identity: device seed already exists," + " skipping");
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    } else {
      log.info("identity: no seed found, skipping");
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

  log.info("doc-cache: starting migration");

  const oldDb = await idbOpen("pokapali:doc-cache", 1);
  if (!oldDb) {
    log.info("doc-cache: no old DB, skipping");
    await metaSet(db, MIGRATION_DOC_CACHE);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("version-index")) {
      log.info("doc-cache: no version-index store, skipping");
      await metaSet(db, MIGRATION_DOC_CACHE);
      return;
    }

    const all = (await idbGetAll(
      oldDb,
      "version-index",
    )) as OldVersionCacheData[];

    if (all.length > 0) {
      let count = 0;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("snapshots", "readwrite");
        const store = tx.objectStore("snapshots");

        for (const doc of all) {
          for (const entry of doc.entries) {
            let cidBytes: Uint8Array;
            try {
              cidBytes = CID.parse(entry.cid).bytes;
            } catch {
              continue;
            }

            store.put({
              ipnsName: doc.ipnsName,
              cid: cidBytes,
              seq: entry.seq,
              ts: entry.ts,
              channel: "",
              epochIndex: 0,
            });
            count++;
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      log.info(`doc-cache: migrated ${count} snapshot entries`);
    } else {
      log.info("doc-cache: no entries, skipping");
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
async function discoverYIndexeddbNames(db: IDBDatabase): Promise<string[]> {
  if (typeof indexedDB.databases === "function") {
    try {
      const all = await indexedDB.databases();
      return all
        .map((d) => d.name ?? "")
        .filter((name) => {
          if (!name) return false;
          if (name.startsWith("pokapali:")) return false;
          const parsed = parseGuid(name);
          if (!parsed) return false;
          return /^[0-9a-f]{64}$/.test(parsed.ipnsName);
        });
    } catch {
      // Fall through to snapshot-based discovery
    }
  }

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

  const known = ["content", "comments", "_meta"];
  const names: string[] = [];
  for (const ipns of ipnsNames) {
    for (const ch of known) {
      names.push(`${ipns}:${ch}`);
    }
  }

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
 * Count edits with legacyId prefix matching a guid.
 * Used for the fast short-circuit: if the count
 * matches the source update count, skip migration.
 */
function countLegacyEdits(db: IDBDatabase, guid: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("edits", "readonly");
    const store = tx.objectStore("edits");
    const index = store.index("by-legacy-id");
    // legacyId format: "{guid}:{key}"
    // Count all keys in range [guid:, guid:\uffff]
    const range = IDBKeyRange.bound(`${guid}:`, `${guid}:\uffff`);
    const req = index.count(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Read all updates from an old y-indexeddb database,
 * preserving their auto-increment keys.
 */
function readOldUpdates(
  oldDb: IDBDatabase,
): Promise<Array<{ key: number; payload: Uint8Array }>> {
  return new Promise((resolve, reject) => {
    const tx = oldDb.transaction("updates", "readonly");
    const store = tx.objectStore("updates");
    const results: Array<{
      key: number;
      payload: Uint8Array;
    }> = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push({
        key: cursor.key as number,
        payload: cursor.value as Uint8Array,
      });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Migrate a single y-indexeddb database into the
 * unified Store's edits table using per-edit legacyId
 * tracking for idempotent, resumable migration.
 */
async function migrateOneYIndexeddb(
  db: IDBDatabase,
  guid: string,
): Promise<void> {
  const parsed = parseGuid(guid);
  if (!parsed) return;

  const oldDb = await idbOpen(guid);
  if (!oldDb) {
    log.info(`${guid}: no old DB found, skipping`);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("updates")) {
      log.info(`${guid}: no updates store, skipping`);
      return;
    }

    const updates = await readOldUpdates(oldDb);

    if (updates.length === 0) {
      log.info(`${guid}: 0 updates, skipping`);
      return;
    }

    // Fast short-circuit: if the count of legacyId
    // edits matches the source count, skip entirely.
    const existing = await countLegacyEdits(db, guid);
    if (existing === updates.length) {
      log.info(`${guid}: ${existing} edits already` + " migrated, skipping");
      return;
    }

    if (existing > 0) {
      log.info(
        `${guid}: ${existing}/${updates.length}` +
          " edits found, resuming migration",
      );
    }

    // Write edits with legacyId. The unique index
    // on legacyId prevents duplicates — we use put()
    // but the unique constraint on the index means
    // we need to use add() and catch ConstraintError
    // for already-migrated edits.
    let added = 0;
    let skipped = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("edits", "readwrite");
      const store = tx.objectStore("edits");

      for (const { key, payload } of updates) {
        const legacyId = `${guid}:${key}`;
        const addReq = store.add({
          ipnsName: parsed.ipnsName,
          channel: parsed.channel,
          epochIndex: 0,
          payload,
          timestamp: 0,
          author: "",
          editChannel: parsed.channel,
          origin: "hydrate",
          signature: new Uint8Array(0),
          legacyId,
        });
        addReq.onsuccess = () => {
          added++;
        };
        // ConstraintError = legacyId already exists
        // (duplicate from partial prior migration).
        // preventDefault() stops the error from
        // propagating to the transaction and aborting.
        addReq.onerror = (event) => {
          if (addReq.error?.name === "ConstraintError") {
            skipped++;
            event.preventDefault();
            event.stopPropagation();
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        reject(tx.error);
      };
    });

    log.info(
      `${guid}: migrated ${added} edits` +
        (skipped > 0 ? ` (${skipped} already present)` : ""),
    );

    // Close epoch 0 with snapshot if available
    // (skip for _meta channel).
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
 * Migration uses per-edit legacyId tracking for
 * idempotent, resumable, per-edit precision. No
 * boolean flags — the edits themselves are the
 * source of truth.
 */
async function migrateYIndexeddb(db: IDBDatabase): Promise<void> {
  try {
    const names = await discoverYIndexeddbNames(db);
    if (names.length > 0) {
      log.info(
        `discovered ${names.length} y-indexeddb` + " databases to check",
      );
    } else {
      log.info("no y-indexeddb databases found");
      return;
    }

    for (const guid of names) {
      try {
        await migrateOneYIndexeddb(db, guid);
      } catch (err) {
        log.warn(`y-indexeddb migration failed for` + ` ${guid}:`, err);
      }
    }
  } catch (err) {
    log.warn("y-indexeddb discovery failed:", err);
  }
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

  const background = migrateYIndexeddb(db)
    .catch((err) => {
      log.warn("y-indexeddb background migration failed:", err);
    })
    .then(() => {
      log.info("runMigrations complete");
    });

  return { background };
}
