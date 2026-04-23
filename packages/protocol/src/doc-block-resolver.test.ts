import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { createDocBlockResolver } from "./doc-block-resolver.js";
import type {
  DocBlockResolverOptions,
  BlockPair,
} from "./doc-block-resolver.js";

// --- Helpers ---

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.create(1, raw.code, hash);
}

const bytes = (...vals: number[]) => new Uint8Array(vals);

/** Minimal BlockGetter stub with an in-memory
 *  blockstore map. */
function createMockHelia() {
  const store = new Map<string, Uint8Array>();
  const putFn = vi.fn((cid: CID, block: Uint8Array) => {
    store.set(cid.toString(), block);
    return Promise.resolve(cid);
  });

  return {
    blockstore: {
      get(cid: CID) {
        const data = store.get(cid.toString());
        if (!data) {
          throw new Error("block not found");
        }
        return data;
      },
      put: putFn,
    },
    store,
    putFn,
  };
}

function baseOpts(
  helia: ReturnType<typeof createMockHelia>,
  overrides?: Partial<DocBlockResolverOptions>,
): DocBlockResolverOptions {
  return {
    getHelia: () => helia,
    httpUrls: () => [],
    ...overrides,
  };
}

describe("DocBlockResolver", () => {
  let helia: ReturnType<typeof createMockHelia>;

  beforeEach(() => {
    helia = createMockHelia();
  });

  describe("basic put/get/getCached", () => {
    it("put makes block available via getCached", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const data = bytes(1, 2, 3);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      expect(resolver.getCached(cid)).toBe(data);
    });

    it("getCached returns null for absent cid", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const cid = await makeCid(bytes(99));
      expect(resolver.getCached(cid)).toBeNull();
    });

    it("put fires IDB write", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const data = bytes(1, 2, 3);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      // Wait for async IDB write
      await vi.waitFor(() => {
        expect(helia.putFn).toHaveBeenCalledWith(cid, data);
      });
    });

    it("ignores zero-length blocks", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const cid = await makeCid(bytes(1));
      resolver.put(cid, new Uint8Array(0));

      expect(resolver.getCached(cid)).toBeNull();
      expect(helia.putFn).not.toHaveBeenCalled();
    });
  });

  describe("has() semantics", () => {
    it("returns true for in-memory blocks", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const data = bytes(1, 2, 3);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      expect(resolver.has(cid)).toBe(true);
    });

    it("returns false for absent blocks", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const cid = await makeCid(bytes(99));
      expect(resolver.has(cid)).toBe(false);
    });

    it("returns true for knownCids (hydrated)", async () => {
      const data = bytes(10, 20);
      const cid = await makeCid(data);

      async function* enumerate(): AsyncIterable<BlockPair> {
        yield { cid, block: data };
      }

      const resolver = createDocBlockResolver(
        baseOpts(helia, {
          enumeratePersistedCids: enumerate,
        }),
      );
      await resolver.ready;

      // Not in LRU, but in knownCids from hydration
      expect(resolver.has(cid)).toBe(true);
      expect(resolver.knownCids.has(cid.toString())).toBe(true);
    });
  });

  describe("knownCids and memoryOnlyCids", () => {
    it("successful put moves cid to knownCids", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const data = bytes(5, 6, 7);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      // Wait for async IDB put to resolve
      await vi.waitFor(() => {
        expect(resolver.knownCids.has(cid.toString())).toBe(true);
      });
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
    });

    it("failed put marks cid as memoryOnly", async () => {
      const onWriteError = vi.fn();
      helia.putFn.mockRejectedValueOnce(new Error("QuotaExceeded"));

      const resolver = createDocBlockResolver(
        baseOpts(helia, { onWriteError }),
      );
      await resolver.ready;

      const data = bytes(5, 6, 7);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      await vi.waitFor(() => {
        expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
      });

      expect(resolver.knownCids.has(cid.toString())).toBe(false);
      expect(resolver.has(cid)).toBe(true);
      expect(onWriteError).toHaveBeenCalledWith(cid, expect.any(Error));
    });

    it("recovery: memoryOnly → known on retry success", async () => {
      const onWriteError = vi.fn();
      const onResolved = vi.fn();

      // First put fails
      helia.putFn.mockRejectedValueOnce(new Error("QuotaExceeded"));

      const resolver = createDocBlockResolver(
        baseOpts(helia, { onWriteError, onResolved }),
      );
      await resolver.ready;

      const data = bytes(5, 6, 7);
      const cid = await makeCid(data);

      // First put — fails IDB
      resolver.put(cid, data);
      await vi.waitFor(() => {
        expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
      });

      // Second put — succeeds (default mock works)
      resolver.put(cid, data);
      await vi.waitFor(() => {
        expect(resolver.knownCids.has(cid.toString())).toBe(true);
      });

      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
      expect(onResolved).toHaveBeenCalledWith(cid);
    });

    it("disjoint invariant holds", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      await resolver.ready;

      const data = bytes(1, 2);
      const cid = await makeCid(data);
      resolver.put(cid, data);

      await vi.waitFor(() => {
        expect(resolver.knownCids.has(cid.toString())).toBe(true);
      });

      // Verify disjoint
      for (const k of resolver.knownCids) {
        expect(resolver.memoryOnlyCids.has(k)).toBe(false);
      }
      for (const m of resolver.memoryOnlyCids) {
        expect(resolver.knownCids.has(m)).toBe(false);
      }
    });
  });

  describe("hydration lifecycle", () => {
    it("ready resolves after hydration", async () => {
      const data = bytes(10, 20);
      const cid = await makeCid(data);

      async function* enumerate(): AsyncIterable<BlockPair> {
        yield { cid, block: data };
      }

      const resolver = createDocBlockResolver(
        baseOpts(helia, {
          enumeratePersistedCids: enumerate,
        }),
      );

      expect(resolver.hydrated).toBe(false);
      await resolver.ready;
      expect(resolver.hydrated).toBe(true);
      expect(resolver.knownCids.size).toBe(1);
    });

    it("hydrates immediately when no enumerator", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia));
      // Should resolve synchronously (microtask)
      await resolver.ready;
      expect(resolver.hydrated).toBe(true);
      expect(resolver.knownCids.size).toBe(0);
    });

    it("hydration failure still resolves ready", async () => {
      // eslint-disable-next-line require-yield
      async function* enumerate(): AsyncIterable<BlockPair> {
        throw new Error("IDB scan failed");
      }

      const resolver = createDocBlockResolver(
        baseOpts(helia, {
          enumeratePersistedCids: enumerate,
        }),
      );
      await resolver.ready;
      expect(resolver.hydrated).toBe(true);
      // knownCids empty due to failure, but not stuck
      expect(resolver.knownCids.size).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest when over budget", async () => {
      const resolver = createDocBlockResolver(baseOpts(helia, { lruBytes: 5 }));
      await resolver.ready;

      const dataA = bytes(1, 2, 3); // 3 bytes
      const dataB = bytes(4, 5); // 2 bytes → 5 total
      const dataC = bytes(6); // overflow → evict A
      const cidA = await makeCid(dataA);
      const cidB = await makeCid(dataB);
      const cidC = await makeCid(dataC);

      resolver.put(cidA, dataA);
      resolver.put(cidB, dataB);
      resolver.put(cidC, dataC);

      // A evicted from LRU
      expect(resolver.getCached(cidA)).toBeNull();
      // B and C still in LRU
      expect(resolver.getCached(cidB)).not.toBeNull();
      expect(resolver.getCached(cidC)).not.toBeNull();
    });

    it("evicted memoryOnly cid loses has()", async () => {
      const onWriteError = vi.fn();

      // All puts fail → all blocks are memoryOnly
      helia.putFn.mockRejectedValue(new Error("QuotaExceeded"));

      const resolver = createDocBlockResolver(
        baseOpts(helia, {
          lruBytes: 5,
          onWriteError,
        }),
      );
      await resolver.ready;

      const dataA = bytes(1, 2, 3);
      const dataB = bytes(4, 5);
      const dataC = bytes(6);
      const cidA = await makeCid(dataA);
      const cidB = await makeCid(dataB);
      const cidC = await makeCid(dataC);

      resolver.put(cidA, dataA);
      resolver.put(cidB, dataB);

      // Wait for failures to register
      await vi.waitFor(() => {
        expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(true);
      });

      // A is has()-true while still in LRU
      expect(resolver.has(cidA)).toBe(true);

      resolver.put(cidC, dataC);

      // A evicted from LRU; memoryOnly with no IDB
      // backup → unrecoverable. has() must return false
      // so catalog doesn't advertise blocks we can't
      // serve. onEvict cleans memoryOnlyCids.
      expect(resolver.getCached(cidA)).toBeNull();
      expect(resolver.has(cidA)).toBe(false);
      expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(false);
    });
  });
});
