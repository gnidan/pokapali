import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createPinnerStore } from "./pinner-store.js";
import type { PinnerStore } from "./pinner-store.js";

let tmpDir: string;
let store: PinnerStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pinner-store-test-"));
  store = await createPinnerStore(join(tmpDir, "pinner-state"));
  await store.open();
});

afterEach(async () => {
  await store.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("pinner-store", () => {
  describe("names", () => {
    it("starts empty", async () => {
      const names = await store.getNames();
      expect(names.size).toBe(0);
    });

    it("adds and retrieves names", async () => {
      await store.addName("aaa");
      await store.addName("bbb");
      const names = await store.getNames();
      expect(names.size).toBe(2);
      expect(names.has("aaa")).toBe(true);
      expect(names.has("bbb")).toBe(true);
    });

    it("hasName returns correct result", async () => {
      expect(await store.hasName("aaa")).toBe(false);
      await store.addName("aaa");
      expect(await store.hasName("aaa")).toBe(true);
    });

    it("removeName deletes all associated keys", async () => {
      await store.addName("aaa");
      await store.setTip("aaa", "cidAAA");
      await store.setAppId("aaa", "app1");
      await store.setLastSeen("aaa", 12345);

      await store.removeName("aaa");

      expect(await store.hasName("aaa")).toBe(false);
      expect(await store.getTip("aaa")).toBeNull();
      expect(await store.getAppId("aaa")).toBeNull();
      expect(await store.getLastSeen("aaa")).toBeNull();
    });

    it("addName is idempotent", async () => {
      await store.addName("aaa");
      await store.addName("aaa");
      const names = await store.getNames();
      expect(names.size).toBe(1);
    });
  });

  describe("tips", () => {
    it("returns null for unknown name", async () => {
      expect(await store.getTip("xxx")).toBeNull();
    });

    it("sets and gets tip", async () => {
      await store.setTip("aaa", "bafyabc");
      expect(await store.getTip("aaa")).toBe("bafyabc");
    });

    it("overwrites tip", async () => {
      await store.setTip("aaa", "old");
      await store.setTip("aaa", "new");
      expect(await store.getTip("aaa")).toBe("new");
    });

    it("getTips returns all", async () => {
      await store.setTip("aaa", "cid1");
      await store.setTip("bbb", "cid2");
      const tips = await store.getTips();
      expect(tips.size).toBe(2);
      expect(tips.get("aaa")).toBe("cid1");
      expect(tips.get("bbb")).toBe("cid2");
    });
  });

  describe("appIds", () => {
    it("returns null for unknown", async () => {
      expect(await store.getAppId("xxx")).toBeNull();
    });

    it("sets and gets appId", async () => {
      await store.setAppId("aaa", "my-app");
      expect(await store.getAppId("aaa")).toBe("my-app");
    });

    it("getAppIds returns all", async () => {
      await store.setAppId("aaa", "app1");
      await store.setAppId("bbb", "app2");
      const map = await store.getAppIds();
      expect(map.size).toBe(2);
      expect(map.get("aaa")).toBe("app1");
    });
  });

  describe("lastSeen", () => {
    it("returns null for unknown", async () => {
      expect(await store.getLastSeen("xxx")).toBeNull();
    });

    it("sets and gets timestamp", async () => {
      await store.setLastSeen("aaa", 1710000000000);
      expect(await store.getLastSeen("aaa")).toBe(1710000000000);
    });

    it("getLastSeenAll returns all", async () => {
      await store.setLastSeen("aaa", 100);
      await store.setLastSeen("bbb", 200);
      const map = await store.getLastSeenAll();
      expect(map.size).toBe(2);
      expect(map.get("aaa")).toBe(100);
      expect(map.get("bbb")).toBe(200);
    });
  });

  describe("persistence", () => {
    it("survives close and reopen", async () => {
      await store.addName("aaa");
      await store.setTip("aaa", "cid1");
      await store.setAppId("aaa", "app1");
      await store.setLastSeen("aaa", 999);

      await store.close();

      // Reopen same path
      const store2 = await createPinnerStore(join(tmpDir, "pinner-state"));
      await store2.open();

      expect(await store2.hasName("aaa")).toBe(true);
      expect(await store2.getTip("aaa")).toBe("cid1");
      expect(await store2.getAppId("aaa")).toBe("app1");
      expect(await store2.getLastSeen("aaa")).toBe(999);

      await store2.close();
    });
  });

  describe("importState", () => {
    it("batch-imports full state", async () => {
      await store.importState({
        knownNames: ["aaa", "bbb", "ccc"],
        tips: { aaa: "cid1", bbb: "cid2" },
        nameToAppId: { aaa: "app1" },
        lastSeenAt: { aaa: 100, bbb: 200 },
      });

      const names = await store.getNames();
      expect(names.size).toBe(3);

      expect(await store.getTip("aaa")).toBe("cid1");
      expect(await store.getTip("ccc")).toBeNull();
      expect(await store.getAppId("aaa")).toBe("app1");
      expect(await store.getLastSeen("bbb")).toBe(200);
    });

    it("handles missing optional fields", async () => {
      await store.importState({
        knownNames: ["aaa"],
        tips: {},
      });

      const names = await store.getNames();
      expect(names.size).toBe(1);
      expect(await store.getTip("aaa")).toBeNull();
      expect(await store.getAppId("aaa")).toBeNull();
    });
  });
});
