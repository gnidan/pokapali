import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Minimal IndexedDB mock with keyPath ---

interface MockStore {
  data: Map<string, unknown>;
  keyPath: string | null;
}

function createMockIDB() {
  const stores = new Map<string, MockStore>();

  const mockIndexedDB = {
    open(dbName: string, _version?: number) {
      const req = {
        result: null as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };

      queueMicrotask(() => {
        const db = {
          objectStoreNames: {
            contains: (name: string) => stores.has(name),
          },
          createObjectStore: (name: string, opts?: { keyPath?: string }) => {
            stores.set(name, {
              data: new Map(),
              keyPath: opts?.keyPath ?? null,
            });
          },
          transaction: (storeName: string, mode?: string) => {
            if (!stores.has(storeName)) {
              stores.set(storeName, {
                data: new Map(),
                keyPath: null,
              });
            }
            const store = stores.get(storeName)!;
            const txResult = {
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              error: null as DOMException | null,
              objectStore: () => ({
                get: (key: string) => {
                  const getReq = {
                    result: store.data.get(key),
                    error: null,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                  };
                  queueMicrotask(() => getReq.onsuccess?.());
                  return getReq;
                },
                put: (value: unknown) => {
                  if (mode === "readwrite") {
                    const key = store.keyPath
                      ? (value as Record<string, string>)[store.keyPath]
                      : String(value);
                    store.data.set(key, value);
                  }
                  queueMicrotask(() => txResult.oncomplete?.());
                },
              }),
            };
            return txResult;
          },
          close: vi.fn(),
        };

        req.result = db as unknown as IDBDatabase;
        req.onupgradeneeded?.();
        queueMicrotask(() => req.onsuccess?.());
      });

      return req;
    },
  };

  return { mockIndexedDB, stores };
}

let idbMock: ReturnType<typeof createMockIDB>;

beforeEach(() => {
  idbMock = createMockIDB();
  vi.stubGlobal("indexedDB", idbMock.mockIndexedDB);
});

const { readVersionCache, writeVersionCache } =
  await import("./version-cache.js");

describe("version-cache", () => {
  it("returns null for unknown ipnsName", async () => {
    const result = await readVersionCache("unknown");
    expect(result).toBeNull();
  });

  it("round-trips entries", async () => {
    const entries = [
      { cid: "bafyabc", seq: 1, ts: 1000 },
      { cid: "bafydef", seq: 2, ts: 2000 },
    ];
    await writeVersionCache("test-ipns", entries);

    const result = await readVersionCache("test-ipns");
    expect(result).not.toBeNull();
    expect(result!.ipnsName).toBe("test-ipns");
    expect(result!.entries).toEqual(entries);
    expect(result!.updatedAt).toBeGreaterThan(0);
  });

  it("overwrites on second write", async () => {
    await writeVersionCache("test-ipns", [
      { cid: "bafyabc", seq: 1, ts: 1000 },
    ]);
    await writeVersionCache("test-ipns", [
      { cid: "bafyxyz", seq: 5, ts: 5000 },
    ]);

    const result = await readVersionCache("test-ipns");
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].cid).toBe("bafyxyz");
  });

  it("isolates entries by ipnsName", async () => {
    await writeVersionCache("doc-a", [{ cid: "bafya", seq: 1, ts: 100 }]);
    await writeVersionCache("doc-b", [{ cid: "bafyb", seq: 2, ts: 200 }]);

    const a = await readVersionCache("doc-a");
    const b = await readVersionCache("doc-b");
    expect(a!.entries[0].cid).toBe("bafya");
    expect(b!.entries[0].cid).toBe("bafyb");
  });

  it("handles empty entries", async () => {
    await writeVersionCache("empty-doc", []);
    const result = await readVersionCache("empty-doc");
    expect(result!.entries).toEqual([]);
  });

  it("returns null when indexedDB unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const result = await readVersionCache("test");
    expect(result).toBeNull();
  });

  it(
    "write silently swallows error when " + "indexedDB unavailable",
    async () => {
      vi.stubGlobal("indexedDB", undefined);
      // Should not throw
      await writeVersionCache("test", [{ cid: "bafyabc", seq: 1, ts: 1000 }]);
    },
  );

  it("handles large entry arrays", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      cid: `bafy-${i}`,
      seq: i + 1,
      ts: i * 1000,
    }));
    await writeVersionCache("big-doc", entries);
    const result = await readVersionCache("big-doc");
    expect(result!.entries).toHaveLength(500);
    expect(result!.entries[0].cid).toBe("bafy-0");
    expect(result!.entries[499].cid).toBe("bafy-499");
  });

  it("concurrent writes — last write wins", async () => {
    // Fire two writes without awaiting the first
    const p1 = writeVersionCache("race-doc", [
      { cid: "bafyold", seq: 1, ts: 100 },
    ]);
    const p2 = writeVersionCache("race-doc", [
      { cid: "bafynew", seq: 2, ts: 200 },
    ]);
    await Promise.all([p1, p2]);

    const result = await readVersionCache("race-doc");
    expect(result).not.toBeNull();
    // The later write should win since put() is
    // called sequentially through the mock
    expect(result!.entries[0].cid).toBe("bafynew");
  });

  it("updatedAt reflects time of write, not " + "read", async () => {
    const beforeWrite = Date.now();
    await writeVersionCache("time-doc", [
      { cid: "bafytime", seq: 1, ts: 1000 },
    ]);
    const afterWrite = Date.now();

    const result = await readVersionCache("time-doc");
    expect(result!.updatedAt).toBeGreaterThanOrEqual(beforeWrite);
    expect(result!.updatedAt).toBeLessThanOrEqual(afterWrite);
  });

  it("read after IDB open error returns null", async () => {
    const brokenIDB = {
      open() {
        const req = {
          result: null,
          error: new DOMException("blocked"),
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    };
    vi.stubGlobal("indexedDB", brokenIDB);

    const result = await readVersionCache("err-doc");
    expect(result).toBeNull();
  });
});
