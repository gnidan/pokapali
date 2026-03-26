import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ViewCacheStore } from "./view-cache.js";

describe("ViewCacheStore", () => {
  let store: ViewCacheStore;

  beforeEach(async () => {
    const dbName = `test-view-cache-${Math.random()}`;
    store = await ViewCacheStore.create(dbName);
  });

  afterEach(() => {
    store.destroy();
  });

  it("returns null for missing entry", async () => {
    const result = await store.read("state", "content", 0);
    expect(result).toBeNull();
  });

  it("writes and reads a single entry", async () => {
    const data = new Uint8Array([1, 2, 3]);
    await store.write("state", "content", 0, data);

    const result = await store.read("state", "content", 0);
    expect(result).toEqual(data);
  });

  it("overwrites existing entry", async () => {
    const data1 = new Uint8Array([1, 2, 3]);
    const data2 = new Uint8Array([4, 5, 6]);
    await store.write("state", "content", 0, data1);
    await store.write("state", "content", 0, data2);

    const result = await store.read("state", "content", 0);
    expect(result).toEqual(data2);
  });

  it("isolates by viewName", async () => {
    const d1 = new Uint8Array([1]);
    const d2 = new Uint8Array([2]);
    await store.write("state", "content", 0, d1);
    await store.write("fingerprint", "content", 0, d2);

    expect(await store.read("state", "content", 0)).toEqual(d1);
    expect(await store.read("fingerprint", "content", 0)).toEqual(d2);
  });

  it("isolates by channel", async () => {
    const d1 = new Uint8Array([1]);
    const d2 = new Uint8Array([2]);
    await store.write("state", "content", 0, d1);
    await store.write("state", "comments", 0, d2);

    expect(await store.read("state", "content", 0)).toEqual(d1);
    expect(await store.read("state", "comments", 0)).toEqual(d2);
  });

  it("isolates by epochOrdinal", async () => {
    const d1 = new Uint8Array([1]);
    const d2 = new Uint8Array([2]);
    await store.write("state", "content", 0, d1);
    await store.write("state", "content", 1, d2);

    expect(await store.read("state", "content", 0)).toEqual(d1);
    expect(await store.read("state", "content", 1)).toEqual(d2);
  });

  it("loadAll returns all entries for a view", async () => {
    await store.write("state", "content", 0, new Uint8Array([1]));
    await store.write("state", "content", 1, new Uint8Array([2]));
    await store.write("state", "comments", 0, new Uint8Array([3]));
    await store.write("fingerprint", "content", 0, new Uint8Array([9]));

    const entries = await store.loadAll("state");
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          channel: "content",
          epochOrdinal: 0,
          data: new Uint8Array([1]),
        },
        {
          channel: "content",
          epochOrdinal: 1,
          data: new Uint8Array([2]),
        },
        {
          channel: "comments",
          epochOrdinal: 0,
          data: new Uint8Array([3]),
        },
      ]),
    );
  });

  it("loadAll returns empty for unknown view", async () => {
    const entries = await store.loadAll("nonexistent");
    expect(entries).toHaveLength(0);
  });

  it("destroy closes the database", async () => {
    store.destroy();
    // Can open a new one without error
    const dbName = `test-reopen-${Math.random()}`;
    const s2 = await ViewCacheStore.create(dbName);
    await s2.write("state", "content", 0, new Uint8Array([1]));
    const result = await s2.read("state", "content", 0);
    expect(result).toEqual(new Uint8Array([1]));
    s2.destroy();
  });
});
