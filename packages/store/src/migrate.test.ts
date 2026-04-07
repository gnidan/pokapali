import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { Store } from "./store.js";

// -- Helpers --

let nextId = 0;
function freshId(): string {
  return `mig-${++nextId}-${Math.random()}`;
}

/**
 * Seed the old identity database with a keypair seed.
 */
function seedOldIdentityDb(appId: string, seed: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`pokapali:identity:${appId}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keypair")) {
        db.createObjectStore("keypair");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("keypair", "readwrite");
      const store = tx.objectStore("keypair");
      store.put({ seed }, "device");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Seed the old doc-cache database with version entries.
 */
function seedOldDocCache(
  entries: Array<{
    ipnsName: string;
    entries: Array<{
      cid: string;
      seq: number;
      ts: number;
    }>;
  }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pokapali:doc-cache", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("version-index")) {
        db.createObjectStore("version-index", {
          keyPath: "ipnsName",
        });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("version-index", "readwrite");
      const store = tx.objectStore("version-index");
      for (const e of entries) {
        store.put({
          ipnsName: e.ipnsName,
          entries: e.entries,
          updatedAt: Date.now(),
        });
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Seed an old y-indexeddb database with raw Yjs
 * updates. The database name is the guid
 * (`{ipnsName}:{channel}`), matching how y-indexeddb
 * names its databases.
 */
function seedYIndexeddb(guid: string, updates: Uint8Array[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(guid, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("updates")) {
        db.createObjectStore("updates", {
          autoIncrement: true,
        });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("updates", "readwrite");
      const store = tx.objectStore("updates");
      for (const u of updates) store.add(u);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

// -- Tests --

describe("migration", () => {
  describe("identity", () => {
    it("copies seed from old identity DB to " + "unified store", async () => {
      const appId = freshId();
      const seed = new Uint8Array([1, 2, 3, 4, 5]);

      // Seed old DB before Store.create
      await seedOldIdentityDb(appId, seed);

      // Store.create should migrate
      const store = await Store.create(appId);
      const loaded = await store.identity.load("device");
      expect(loaded).toEqual(seed);
      store.close();
    });

    it("does not overwrite identity set by new " + "code path", async () => {
      const appId = freshId();
      const oldSeed = new Uint8Array([1, 2, 3]);
      const newSeed = new Uint8Array([4, 5, 6]);

      // Create store first, save new identity
      const store1 = await Store.create(appId);
      await store1.identity.save("device", newSeed);
      store1.close();

      // Now seed old DB (simulating race condition)
      await seedOldIdentityDb(appId, oldSeed);

      // Re-open store — migration should NOT
      // overwrite the new seed
      const store2 = await Store.create(appId);
      const loaded = await store2.identity.load("device");
      expect(loaded).toEqual(newSeed);
      store2.close();
    });

    it("handles missing old identity DB", async () => {
      const appId = freshId();

      // No old DB seeded — should not error
      const store = await Store.create(appId);
      const loaded = await store.identity.load("device");
      expect(loaded).toBeNull();
      store.close();
    });

    it("migration is idempotent", async () => {
      const appId = freshId();
      const seed = new Uint8Array([10, 20, 30]);

      await seedOldIdentityDb(appId, seed);

      // First open migrates
      const store1 = await Store.create(appId);
      expect(await store1.identity.load("device")).toEqual(seed);
      store1.close();

      // Second open — migration already done
      const store2 = await Store.create(appId);
      expect(await store2.identity.load("device")).toEqual(seed);
      store2.close();
    });
  });

  describe("doc-cache", () => {
    it("copies version entries to snapshots store", async () => {
      const appId = freshId();
      const ipnsName = "test-doc-" + appId;

      // Use a valid CIDv1 string (base32)
      const cidStr =
        "bafyreigdp2ksn3n2olbyb4if54oonbslt5sp" + "lsdrwgi5ezr6fy6zl4sney";

      await seedOldDocCache([
        {
          ipnsName,
          entries: [
            { cid: cidStr, seq: 1, ts: 1000 },
            { cid: cidStr, seq: 2, ts: 2000 },
          ],
        },
      ]);

      const store = await Store.create(appId);
      const snaps = await store.documents.get(ipnsName).snapshots.loadAll();

      // Should have migrated entries
      expect(snaps.length).toBeGreaterThanOrEqual(1);
      store.close();
    });

    it("handles missing doc-cache DB", async () => {
      const appId = freshId();

      // No old DB — should not error
      const store = await Store.create(appId);
      const snaps = await store.documents
        .get("nonexistent")
        .snapshots.loadAll();
      expect(snaps).toHaveLength(0);
      store.close();
    });

    it("migration is idempotent", async () => {
      const appId = freshId();
      const ipnsName = "idem-doc-" + appId;
      const cidStr =
        "bafyreigdp2ksn3n2olbyb4if54oonbslt5sp" + "lsdrwgi5ezr6fy6zl4sney";

      await seedOldDocCache([
        {
          ipnsName,
          entries: [{ cid: cidStr, seq: 1, ts: 1000 }],
        },
      ]);

      // First open migrates
      const store1 = await Store.create(appId);
      const snaps1 = await store1.documents.get(ipnsName).snapshots.loadAll();
      store1.close();

      // Second open — no duplicates
      const store2 = await Store.create(appId);
      const snaps2 = await store2.documents.get(ipnsName).snapshots.loadAll();
      expect(snaps2.length).toBe(snaps1.length);
      store2.close();
    });
  });

  describe("y-indexeddb", () => {
    // 64 hex chars for a realistic ipnsName
    const IPNS =
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" + "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    it(
      "copies raw updates from old y-indexeddb " + "into edits store",
      async () => {
        const appId = freshId();
        const guid = `${IPNS}:content`;
        const updates = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
        await seedYIndexeddb(guid, updates);

        const store = await Store.create(appId);
        await store.migrated;
        const epochs = await store.documents
          .get(IPNS)
          .history("content")
          .load();

        expect(epochs.length).toBeGreaterThanOrEqual(1);
        const allEdits = epochs.flatMap((e) => e.edits);
        expect(allEdits).toHaveLength(2);
        expect(Array.from(allEdits[0]!.payload)).toEqual([1, 2, 3]);
        expect(Array.from(allEdits[1]!.payload)).toEqual([4, 5, 6]);
        expect(allEdits[0]!.origin).toBe("hydrate");
        expect(allEdits[0]!.author).toBe("");
        expect(allEdits[0]!.timestamp).toBe(0);
        store.close();
      },
    );

    it("migrates _meta channel", async () => {
      const appId = freshId();
      const guid = `${IPNS}:_meta`;
      await seedYIndexeddb(guid, [new Uint8Array([10, 20])]);

      const store = await Store.create(appId);
      await store.migrated;
      const epochs = await store.documents.get(IPNS).history("_meta").load();

      const allEdits = epochs.flatMap((e) => e.edits);
      expect(allEdits).toHaveLength(1);
      expect(Array.from(allEdits[0]!.payload)).toEqual([10, 20]);
      // _meta should NOT have a closed boundary
      expect(epochs[0]!.boundary.tag).toBe("open");
      store.close();
    });

    it("closes epoch 0 with snapshot if one " + "exists", async () => {
      const appId = freshId();
      const guid = `${IPNS}:content`;
      const cidStr =
        "bafyreigdp2ksn3n2olbyb4if54oonbslt5sp" + "lsdrwgi5ezr6fy6zl4sney";

      // Seed doc-cache so a snapshot migrates first
      await seedOldDocCache([
        {
          ipnsName: IPNS,
          entries: [{ cid: cidStr, seq: 1, ts: 1000 }],
        },
      ]);
      // Seed y-indexeddb
      await seedYIndexeddb(guid, [new Uint8Array([1])]);

      const store = await Store.create(appId);
      await store.migrated;
      const epochs = await store.documents.get(IPNS).history("content").load();

      // Epoch 0 should be snapshotted, epoch 1 open
      expect(epochs.length).toBeGreaterThanOrEqual(2);
      expect(epochs[0]!.boundary.tag).toBe("snapshotted");
      expect(epochs[epochs.length - 1]!.boundary.tag).toBe("open");
      store.close();
    });

    it("is idempotent across reopens", async () => {
      const appId = freshId();
      const guid = `${IPNS}:content`;
      await seedYIndexeddb(guid, [new Uint8Array([1, 2])]);

      const s1 = await Store.create(appId);
      await s1.migrated;
      const e1 = await s1.documents.get(IPNS).history("content").load();
      const count1 = e1.flatMap((e) => e.edits).length;
      s1.close();

      // Second open — should NOT duplicate
      const s2 = await Store.create(appId);
      await s2.migrated;
      const e2 = await s2.documents.get(IPNS).history("content").load();
      const count2 = e2.flatMap((e) => e.edits).length;
      expect(count2).toBe(count1);
      s2.close();
    });

    it("handles missing y-indexeddb DB", async () => {
      const appId = freshId();
      // No old DB — should not error
      const store = await Store.create(appId);
      await store.migrated;
      const epochs = await store.documents
        .get("nonexistent")
        .history("content")
        .load();
      expect(epochs).toHaveLength(0);
      store.close();
    });
  });
});
