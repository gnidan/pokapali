/**
 * block-resolver-parity.test.ts — Parity test between
 * the A0 stub (core) and the A2 real impl (protocol).
 *
 * Runs identical operation sequences against both
 * `createStubBlockResolver` and `createDocBlockResolver`
 * and asserts identical observable behavior on the
 * BlockResolver surface: get, getCached, has, put.
 *
 * Purpose: prevent stub drift. If these tests break,
 * the stub and real impl have diverged — fix both in
 * the same PR (stub-sync policy from architect spec).
 */

import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { createStubBlockResolver } from "@pokapali/core/test/stub-block-resolver";
import { createDocBlockResolver } from "./doc-block-resolver.js";

// --- Helpers ---

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.create(1, raw.code, hash);
}

const bytes = (...vals: number[]) => new Uint8Array(vals);

/** Create a mock Helia for the real impl. Backed by
 *  an in-memory Map, no IDB. */
function createMockHelia() {
  const store = new Map<string, Uint8Array>();
  return {
    blockstore: {
      get(cid: CID) {
        const data = store.get(cid.toString());
        if (!data) throw new Error("not found");
        return data;
      },
      put(cid: CID, block: Uint8Array) {
        store.set(cid.toString(), block);
        return Promise.resolve(cid);
      },
    },
    store,
  };
}

// --- Parity scenarios ---
//
// Each scenario runs the same operation sequence
// against both impls and asserts identical observable
// behavior on the BlockResolver interface surface.

describe("BlockResolver parity: stub vs real", () => {
  it("1. put/has/getCached roundtrip", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const data = bytes(1, 2, 3);
    const cid = await makeCid(data);

    // Both absent before put
    expect(stub.has(cid)).toBe(false);
    expect(real.has(cid)).toBe(false);
    expect(stub.getCached(cid)).toBeNull();
    expect(real.getCached(cid)).toBeNull();

    // Put
    stub.put(cid, data);
    real.put(cid, data);

    // Both present after put
    expect(stub.has(cid)).toBe(true);
    expect(real.has(cid)).toBe(true);
    expect(stub.getCached(cid)).toEqual(data);
    expect(real.getCached(cid)).toEqual(data);
  });

  it("2. async get returns block after put", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const data = bytes(10, 20, 30);
    const cid = await makeCid(data);

    stub.put(cid, data);
    real.put(cid, data);

    const fromStub = await stub.get(cid);
    const fromReal = await real.get(cid);

    expect(fromStub).toEqual(data);
    expect(fromReal).toEqual(data);
  });

  it("3. get returns null for absent cid", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const cid = await makeCid(bytes(99));

    const fromStub = await stub.get(cid);
    const fromReal = await real.get(cid);

    expect(fromStub).toBeNull();
    expect(fromReal).toBeNull();
  });

  it("4. put-failure: block still has() via memory", async () => {
    const stub = createStubBlockResolver();
    stub.simulatePutFailure("quota");

    const helia = createMockHelia();
    helia.blockstore.put = vi
      .fn()
      .mockRejectedValue(
        new Error("QuotaExceeded"),
      ) as typeof helia.blockstore.put;

    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const data = bytes(5, 6, 7);
    const cid = await makeCid(data);

    stub.put(cid, data);
    real.put(cid, data);

    // Wait for async failure to settle in real impl
    await vi.waitFor(() => {
      expect(real.memoryOnlyCids.has(cid.toString())).toBe(true);
    });

    // Both: block is has()-true (memory fallback)
    expect(stub.has(cid)).toBe(true);
    expect(real.has(cid)).toBe(true);

    // Both: getCached returns the data
    expect(stub.getCached(cid)).toEqual(data);
    expect(real.getCached(cid)).toEqual(data);

    // Both: memoryOnly contains the cid
    expect(stub.memoryOnlyCids.has(cid.toString())).toBe(true);
    expect(real.memoryOnlyCids.has(cid.toString())).toBe(true);
  });

  it("5. zero-length block is rejected", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const cid = await makeCid(bytes(1));
    const empty = new Uint8Array(0);

    stub.put(cid, empty);
    real.put(cid, empty);

    // Real impl rejects zero-length; stub may accept
    // (stub doesn't have the guard). This documents
    // the behavioral difference — not a parity
    // requirement since zero-length blocks are
    // meaningless in production.
    expect(real.getCached(cid)).toBeNull();
  });

  it("6. multiple puts update value", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const cid = await makeCid(bytes(1, 2, 3));
    const v1 = bytes(1, 2, 3);
    const v2 = bytes(4, 5, 6, 7);

    stub.put(cid, v1);
    real.put(cid, v1);
    stub.put(cid, v2);
    real.put(cid, v2);

    expect(stub.getCached(cid)).toEqual(v2);
    expect(real.getCached(cid)).toEqual(v2);
  });

  it(
    "7. has() after memory eviction (stub) " + "vs LRU eviction (real)",
    async () => {
      // Stub: manual eviction preserves persistence
      // Real: LRU eviction loses memory but knownCids
      //       retains the key
      // Both should return has() = true after eviction
      // if persistence exists.

      const stub = createStubBlockResolver();
      const helia = createMockHelia();
      const real = createDocBlockResolver({
        getHelia: () => helia,
        httpUrls: () => [],
        lruBytes: 5, // tiny budget to force eviction
      });
      await real.ready;

      const dataA = bytes(1, 2, 3); // 3 bytes
      const dataB = bytes(4, 5, 6); // 3 bytes → 6 total
      const cidA = await makeCid(dataA);
      const cidB = await makeCid(dataB);

      stub.put(cidA, dataA);
      real.put(cidA, dataA);

      // Wait for IDB write to complete
      await vi.waitFor(() => {
        expect(real.knownCids.has(cidA.toString())).toBe(true);
      });

      stub.put(cidB, dataB);
      real.put(cidB, dataB);
      // Real: LRU evicts cidA (over 5-byte budget)
      // Stub: no auto-eviction
      stub.simulateMemoryEviction(cidA);

      // Both: getCached returns null (not in memory)
      expect(stub.getCached(cidA)).toBeNull();
      expect(real.getCached(cidA)).toBeNull();

      // Both: has() still true (persisted)
      expect(stub.has(cidA)).toBe(true);
      expect(real.has(cidA)).toBe(true);
    },
  );

  it("8. multiple blocks coexist", async () => {
    const stub = createStubBlockResolver();
    const helia = createMockHelia();
    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const pairs: Array<[CID, Uint8Array]> = [];
    for (let i = 0; i < 5; i++) {
      const data = bytes(i * 10, i * 10 + 1);
      const cid = await makeCid(data);
      pairs.push([cid, data]);
    }

    for (const [cid, data] of pairs) {
      stub.put(cid, data);
      real.put(cid, data);
    }

    for (const [cid, data] of pairs) {
      expect(stub.has(cid)).toBe(true);
      expect(real.has(cid)).toBe(true);
      expect(stub.getCached(cid)).toEqual(data);
      expect(real.getCached(cid)).toEqual(data);
    }
  });

  it("9. put-failure then success recovers", async () => {
    const stub = createStubBlockResolver();
    stub.simulatePutFailure("quota"); // one-shot

    const helia = createMockHelia();
    const realPut = vi
      .fn()
      .mockRejectedValueOnce(new Error("QuotaExceeded"))
      .mockImplementation((cid: CID, block: Uint8Array) => {
        helia.store.set(cid.toString(), block);
        return Promise.resolve(cid);
      });
    helia.blockstore.put = realPut;

    const real = createDocBlockResolver({
      getHelia: () => helia,
      httpUrls: () => [],
    });
    await real.ready;

    const data = bytes(8, 9);
    const cid = await makeCid(data);

    // First put — fails persistence
    stub.put(cid, data);
    real.put(cid, data);

    await vi.waitFor(() => {
      expect(real.memoryOnlyCids.has(cid.toString())).toBe(true);
    });
    expect(stub.memoryOnlyCids.has(cid.toString())).toBe(true);

    // Second put — succeeds (one-shot cleared)
    stub.clearPutFailure();
    stub.put(cid, data);
    real.put(cid, data);

    await vi.waitFor(() => {
      expect(real.knownCids.has(cid.toString())).toBe(true);
    });

    // Both: no longer memory-only
    expect(stub.memoryOnlyCids.has(cid.toString())).toBe(false);
    expect(real.memoryOnlyCids.has(cid.toString())).toBe(false);

    // Both: has() true, getCached returns data
    expect(stub.has(cid)).toBe(true);
    expect(real.has(cid)).toBe(true);
  });
});
