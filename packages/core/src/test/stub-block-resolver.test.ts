import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  createStubBlockResolver,
  cidMatchesBlock,
} from "./stub-block-resolver.js";

const DAG_CBOR = 0x71;

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR, hash);
}

describe("createStubBlockResolver", () => {
  describe("seeding", () => {
    it("pre-seeds both tiers from initialBlocks", async () => {
      const data = new TextEncoder().encode("seed");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver({
        initialBlocks: [[cid, data]],
      });
      expect(resolver.has(cid)).toBe(true);
      expect(resolver.getCached(cid)).toEqual(data);
      expect(await resolver.get(cid)).toEqual(data);
    });

    it("seed does not count toward putCount", async () => {
      const data = new TextEncoder().encode("seed");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver({
        initialBlocks: [[cid, data]],
      });
      expect(resolver.putCount).toBe(0);
    });
  });

  describe("put / has / getCached roundtrip", () => {
    it("put() makes has() and getCached() succeed", async () => {
      const data = new TextEncoder().encode("hi");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();

      expect(resolver.has(cid)).toBe(false);
      expect(resolver.getCached(cid)).toBeNull();

      resolver.put(cid, data);

      expect(resolver.has(cid)).toBe(true);
      expect(resolver.getCached(cid)).toEqual(data);
      expect(resolver.putCount).toBe(1);
    });

    it("put() never throws even under failure", async () => {
      const data = new TextEncoder().encode("hi");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      resolver.simulatePersistentPutFailure("quota");
      expect(() => resolver.put(cid, data)).not.toThrow();
    });

    it("put() is synchronous — has() true in same tick", async () => {
      const data = new TextEncoder().encode("hi");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      resolver.put(cid, data);
      // Same tick, no await:
      expect(resolver.has(cid)).toBe(true);
    });

    it("storedCids reflects all stored blocks", async () => {
      const a = new TextEncoder().encode("a");
      const b = new TextEncoder().encode("b");
      const cidA = await makeCid(a);
      const cidB = await makeCid(b);
      const resolver = createStubBlockResolver();
      resolver.put(cidA, a);
      resolver.put(cidB, b);
      expect(resolver.storedCids.size).toBe(2);
      expect(resolver.storedCids.has(cidA.toString())).toBe(true);
      expect(resolver.storedCids.has(cidB.toString())).toBe(true);
    });
  });

  describe("memory eviction vs block loss", () => {
    it("simulateMemoryEviction drops memory; has() stays true", async () => {
      const data = new TextEncoder().encode("evict");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      resolver.put(cid, data);

      resolver.simulateMemoryEviction(cid);

      // Memory-tier null but persistence still has it.
      expect(resolver.getCached(cid)).toBeNull();
      expect(resolver.has(cid)).toBe(true);
      expect(await resolver.get(cid)).toEqual(data);
    });

    it("simulateBlockLoss drops both tiers; has() becomes false", async () => {
      const data = new TextEncoder().encode("loss");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      resolver.put(cid, data);

      resolver.simulateBlockLoss(cid);

      expect(resolver.has(cid)).toBe(false);
      expect(resolver.getCached(cid)).toBeNull();
      expect(await resolver.get(cid)).toBeNull();
    });
  });

  describe("put-failure injection — single-shot", () => {
    it("simulatePutFailure affects only next put()", async () => {
      const a = new TextEncoder().encode("a");
      const b = new TextEncoder().encode("b");
      const cidA = await makeCid(a);
      const cidB = await makeCid(b);
      const resolver = createStubBlockResolver();

      resolver.simulatePutFailure("quota");
      resolver.put(cidA, a);
      resolver.put(cidB, b);

      // A is memory-only (put during injection).
      expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(true);
      // B is normal (injection auto-reset).
      expect(resolver.memoryOnlyCids.has(cidB.toString())).toBe(false);

      // Both still has()-available.
      expect(resolver.has(cidA)).toBe(true);
      expect(resolver.has(cidB)).toBe(true);
    });
  });

  describe("put-failure injection — persistent", () => {
    it("simulatePersistentPutFailure affects all until cleared", async () => {
      const a = new TextEncoder().encode("a");
      const b = new TextEncoder().encode("b");
      const cidA = await makeCid(a);
      const cidB = await makeCid(b);
      const resolver = createStubBlockResolver();

      resolver.simulatePersistentPutFailure("unavailable");
      resolver.put(cidA, a);
      resolver.put(cidB, b);

      expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(true);
      expect(resolver.memoryOnlyCids.has(cidB.toString())).toBe(true);

      resolver.clearPutFailure();

      const c = new TextEncoder().encode("c");
      const cidC = await makeCid(c);
      resolver.put(cidC, c);
      expect(resolver.memoryOnlyCids.has(cidC.toString())).toBe(false);
    });

    it("normal put() on memory-only CID re-persists it", async () => {
      const data = new TextEncoder().encode("retry");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();

      resolver.simulatePutFailure("quota");
      resolver.put(cid, data);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);

      // Second put() succeeds (one-shot injection cleared).
      resolver.put(cid, data);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
    });
  });

  describe("memory-only + eviction interaction", () => {
    it("evicting memory-only CID removes from memoryOnlyCids", async () => {
      const data = new TextEncoder().encode("memonly");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();

      resolver.simulatePutFailure("quota");
      resolver.put(cid, data);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);

      resolver.simulateMemoryEviction(cid);
      // Gone entirely — not in memory, not in persistence.
      expect(resolver.has(cid)).toBe(false);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
    });

    it("simulateBlockLoss on a memory-only CID clears it", async () => {
      const data = new TextEncoder().encode("memonly-loss");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();

      resolver.simulatePutFailure("quota");
      resolver.put(cid, data);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);

      resolver.simulateBlockLoss(cid);
      expect(resolver.has(cid)).toBe(false);
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
    });
  });

  describe("inspection counters", () => {
    it("putCount increments on every put()", async () => {
      const data = new TextEncoder().encode("x");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      expect(resolver.putCount).toBe(0);
      resolver.put(cid, data);
      resolver.put(cid, data);
      expect(resolver.putCount).toBe(2);
    });

    it("getCachedCount increments on every getCached()", async () => {
      const data = new TextEncoder().encode("x");
      const cid = await makeCid(data);
      const resolver = createStubBlockResolver();
      expect(resolver.getCachedCount).toBe(0);
      resolver.getCached(cid);
      resolver.getCached(cid);
      resolver.getCached(cid);
      expect(resolver.getCachedCount).toBe(3);
    });
  });

  describe("cidMatchesBlock helper", () => {
    it("returns true for matching CID/data", async () => {
      const data = new TextEncoder().encode("match");
      const cid = await makeCid(data);
      expect(await cidMatchesBlock(cid, data)).toBe(true);
    });

    it("returns false for tampered data", async () => {
      const data = new TextEncoder().encode("original");
      const cid = await makeCid(data);
      const tampered = new TextEncoder().encode("tampered");
      expect(await cidMatchesBlock(cid, tampered)).toBe(false);
    });
  });
});
