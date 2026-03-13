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
});
