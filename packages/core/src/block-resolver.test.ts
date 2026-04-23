import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createBlockResolver } from "./block-resolver.js";
import type { BlockGetter } from "./fetch-block.js";

const DAG_CBOR = 0x71;

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR, hash);
}

function mockBlockGetter(
  store: Map<string, Uint8Array> = new Map(),
): BlockGetter {
  return {
    blockstore: {
      get: vi.fn(async (cid: CID) => {
        const block = store.get(cid.toString());
        if (!block) {
          throw new Error("not found");
        }
        return block;
      }),
      put: vi.fn() as BlockGetter["blockstore"]["put"],
    },
  };
}

describe("BlockResolver", () => {
  let block: Uint8Array;
  let cid: CID;
  let otherBlock: Uint8Array;
  let otherCid: CID;

  beforeEach(async () => {
    block = new TextEncoder().encode("hello");
    cid = await makeCid(block);
    otherBlock = new TextEncoder().encode("world");
    otherCid = await makeCid(otherBlock);
  });

  describe("getCached()", () => {
    it("returns null for unknown CID", () => {
      const resolver = createBlockResolver({
        getHelia: () => mockBlockGetter(),
        httpUrls: () => [],
      });
      expect(resolver.getCached(cid)).toBeNull();
    });

    it("returns block after put()", () => {
      const resolver = createBlockResolver({
        getHelia: () => mockBlockGetter(),
        httpUrls: () => [],
      });
      resolver.put(cid, block);
      expect(resolver.getCached(cid)).toEqual(block);
    });

    it("does not return blocks only in IDB/blockstore", async () => {
      const store = new Map<string, Uint8Array>();
      store.set(cid.toString(), block);
      const resolver = createBlockResolver({
        getHelia: () => mockBlockGetter(store),
        httpUrls: () => [],
      });
      // Block is in blockstore but not in memory
      expect(resolver.getCached(cid)).toBeNull();
    });
  });

  describe("put()", () => {
    it("makes block available via getCached()", () => {
      const resolver = createBlockResolver({
        getHelia: () => mockBlockGetter(),
        httpUrls: () => [],
      });
      resolver.put(cid, block);
      expect(resolver.getCached(cid)).toEqual(block);
    });

    it("writes to blockstore", () => {
      const getter = mockBlockGetter();
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      resolver.put(cid, block);
      expect(getter.blockstore.put).toHaveBeenCalledWith(cid, block);
    });

    it("ignores empty blocks", () => {
      const getter = mockBlockGetter();
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      resolver.put(cid, new Uint8Array(0));
      expect(resolver.getCached(cid)).toBeNull();
      expect(getter.blockstore.put).not.toHaveBeenCalled();
    });

    it("tolerates blockstore.put failure", async () => {
      const getter = mockBlockGetter();
      (getter.blockstore.put as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("IDB write failed"),
      );
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      // Should not throw
      resolver.put(cid, block);
      // Block is still in memory cache
      expect(resolver.getCached(cid)).toEqual(block);
    });

    it("calls onWriteError on blockstore.put failure", async () => {
      const getter = mockBlockGetter();
      (getter.blockstore.put as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("QuotaExceededError"),
      );
      const onWriteError = vi.fn();
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
        onWriteError,
      });
      resolver.put(cid, block);
      // Let the rejected promise settle
      await vi.waitFor(() => {
        expect(onWriteError).toHaveBeenCalledTimes(1);
      });
      expect(onWriteError).toHaveBeenCalledWith(
        cid,
        expect.objectContaining({
          message: "QuotaExceededError",
        }),
      );
    });

    it("calls onWriteError when getHelia throws", () => {
      const onWriteError = vi.fn();
      const resolver = createBlockResolver({
        getHelia: () => {
          throw new Error("no helia");
        },
        httpUrls: () => [],
        onWriteError,
      });
      resolver.put(cid, block);
      expect(onWriteError).toHaveBeenCalledTimes(1);
      expect(onWriteError).toHaveBeenCalledWith(
        cid,
        expect.objectContaining({
          message: "no helia",
        }),
      );
    });

    it("tolerates missing blockstore.put", () => {
      const getter: BlockGetter = {
        blockstore: {
          get: vi.fn(),
        },
      };
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      // Should not throw when put is undefined
      resolver.put(cid, block);
      expect(resolver.getCached(cid)).toEqual(block);
    });

    it("tolerates getHelia() throwing", () => {
      const resolver = createBlockResolver({
        getHelia: () => {
          throw new Error("no helia");
        },
        httpUrls: () => [],
      });
      // Should not throw — block still cached in memory
      resolver.put(cid, block);
      expect(resolver.getCached(cid)).toEqual(block);
    });
  });

  describe("get()", () => {
    it("returns from memory cache first", async () => {
      const getter = mockBlockGetter();
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      resolver.put(cid, block);
      const result = await resolver.get(cid);
      expect(result).toEqual(block);
      // Should not hit blockstore at all
      expect(getter.blockstore.get).not.toHaveBeenCalled();
    });

    it("falls through to fetchBlock on cache miss", async () => {
      const store = new Map<string, Uint8Array>();
      store.set(cid.toString(), block);
      const getter = mockBlockGetter(store);
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      const result = await resolver.get(cid);
      expect(result).toEqual(block);
      // Should have hit blockstore
      expect(getter.blockstore.get).toHaveBeenCalled();
    });

    it("caches block after fetchBlock succeeds", async () => {
      const store = new Map<string, Uint8Array>();
      store.set(cid.toString(), block);
      const getter = mockBlockGetter(store);
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      await resolver.get(cid);
      // Second get should come from memory
      (getter.blockstore.get as ReturnType<typeof vi.fn>).mockClear();
      const result = await resolver.get(cid);
      expect(result).toEqual(block);
      expect(getter.blockstore.get).not.toHaveBeenCalled();
    });

    it("returns null on total miss", async () => {
      const getter = mockBlockGetter();
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      const result = await resolver.get(cid);
      expect(result).toBeNull();
    });

    it("returns null when fetchBlock returns empty", async () => {
      const store = new Map<string, Uint8Array>();
      store.set(cid.toString(), new Uint8Array(0));
      const getter = mockBlockGetter(store);
      // Override to return empty instead of throwing
      (getter.blockstore.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Uint8Array(0),
      );
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      const result = await resolver.get(cid);
      expect(result).toBeNull();
    });

    it("returns null when getHelia() throws", async () => {
      const resolver = createBlockResolver({
        getHelia: () => {
          throw new Error("no helia");
        },
        httpUrls: () => [],
      });
      const result = await resolver.get(cid);
      expect(result).toBeNull();
    });

    it("isolates different CIDs", async () => {
      const resolver = createBlockResolver({
        getHelia: () => mockBlockGetter(),
        httpUrls: () => [],
      });
      resolver.put(cid, block);
      resolver.put(otherCid, otherBlock);
      expect(resolver.getCached(cid)).toEqual(block);
      expect(resolver.getCached(otherCid)).toEqual(otherBlock);
      expect(await resolver.get(cid)).toEqual(block);
      expect(await resolver.get(otherCid)).toEqual(otherBlock);
    });

    it("concurrent gets for same CID both resolve", async () => {
      const store = new Map<string, Uint8Array>();
      store.set(cid.toString(), block);
      const getter = mockBlockGetter(store);
      const resolver = createBlockResolver({
        getHelia: () => getter,
        httpUrls: () => [],
      });
      const [a, b] = await Promise.all([resolver.get(cid), resolver.get(cid)]);
      expect(a).toEqual(block);
      expect(b).toEqual(block);
    });
  });
});
