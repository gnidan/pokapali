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
});
