/**
 * doc-block-resolver.integration.test.ts — D2 (#112)
 *
 * Integration + failure-injection tests for the A2
 * layered BlockResolver. Targets async concurrency
 * gaps not covered by the unit tests:
 *
 *   - Interleaved put success/failure sequences
 *   - Disjoint invariant (knownCids ∩ memoryOnlyCids = ∅)
 *     under rapid LRU eviction + concurrent IDB writes
 *   - Hydration + concurrent put races
 *   - Property-based model testing against the real impl
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import * as fc from "fast-check";
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

// Pre-warm CID cache for property tests (async CID
// generation, sync property execution).
const cidCache: CID[] = [];
const cidData: Uint8Array[] = [];

beforeAll(async () => {
  for (let i = 0; i < 64; i++) {
    const data = bytes(i, i + 1, i + 2);
    cidData.push(data);
    cidCache.push(await makeCid(data));
  }
});

/** Mock Helia with controllable put behavior. */
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
        if (!data) throw new Error("not found");
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

/** Assert disjoint invariant: no CID appears in both
 *  knownCids and memoryOnlyCids. */
function assertDisjoint(
  resolver: ReturnType<typeof createDocBlockResolver>,
): void {
  for (const k of resolver.knownCids) {
    expect(
      resolver.memoryOnlyCids.has(k),
      `CID ${k.slice(0, 12)}... in both known and memoryOnly`,
    ).toBe(false);
  }
  for (const m of resolver.memoryOnlyCids) {
    expect(
      resolver.knownCids.has(m),
      `CID ${m.slice(0, 12)}... in both memoryOnly and known`,
    ).toBe(false);
  }
}

// --- Interleaved success/failure sequences ---

describe("interleaved put success/failure", () => {
  it("alternating success/failure preserves disjoint", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();

    // Odd-indexed puts fail, even succeed
    let callCount = 0;
    helia.blockstore.put = vi.fn((cid: CID, block: Uint8Array) => {
      callCount++;
      if (callCount % 2 === 0) {
        return Promise.reject(new Error("QuotaExceeded"));
      }
      helia.store.set(cid.toString(), block);
      return Promise.resolve(cid);
    }) as typeof helia.blockstore.put;

    const resolver = createDocBlockResolver(baseOpts(helia, { onWriteError }));
    await resolver.ready;

    const cids: CID[] = [];
    for (let i = 0; i < 6; i++) {
      const data = bytes(100 + i);
      const cid = await makeCid(data);
      cids.push(cid);
      resolver.put(cid, data);
    }

    // Wait for all async IDB writes to settle
    await vi.waitFor(() => {
      const totalTracked =
        resolver.knownCids.size + resolver.memoryOnlyCids.size;
      expect(totalTracked).toBe(6);
    });

    assertDisjoint(resolver);

    // All blocks are has()-true (memory or persisted)
    for (const cid of cids) {
      expect(resolver.has(cid)).toBe(true);
    }
  });

  it("burst of failures then burst of successes", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();
    const onResolved = vi.fn();

    // First 4 puts fail
    for (let i = 0; i < 4; i++) {
      helia.putFn.mockRejectedValueOnce(new Error("QuotaExceeded"));
    }

    const resolver = createDocBlockResolver(
      baseOpts(helia, { onWriteError, onResolved }),
    );
    await resolver.ready;

    // Put 4 blocks — all fail IDB
    const failCids: CID[] = [];
    for (let i = 0; i < 4; i++) {
      const data = bytes(200 + i);
      const cid = await makeCid(data);
      failCids.push(cid);
      resolver.put(cid, data);
    }

    await vi.waitFor(() => {
      expect(resolver.memoryOnlyCids.size).toBe(4);
    });

    assertDisjoint(resolver);
    expect(resolver.knownCids.size).toBe(0);

    // Retry all 4 — default mock succeeds
    for (let i = 0; i < 4; i++) {
      resolver.put(failCids[i]!, bytes(200 + i));
    }

    await vi.waitFor(() => {
      expect(resolver.knownCids.size).toBe(4);
    });

    expect(resolver.memoryOnlyCids.size).toBe(0);
    assertDisjoint(resolver);
    expect(onResolved).toHaveBeenCalledTimes(4);
  });

  it("same CID: fail then succeed recovers", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();
    const onResolved = vi.fn();

    helia.putFn.mockRejectedValueOnce(new Error("QuotaExceeded"));

    const resolver = createDocBlockResolver(
      baseOpts(helia, { onWriteError, onResolved }),
    );
    await resolver.ready;

    const data = bytes(42, 43);
    const cid = await makeCid(data);

    // First put — fails
    resolver.put(cid, data);
    await vi.waitFor(() => {
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
    });
    expect(onWriteError).toHaveBeenCalledTimes(1);

    // Second put — succeeds
    resolver.put(cid, data);
    await vi.waitFor(() => {
      expect(resolver.knownCids.has(cid.toString())).toBe(true);
    });

    expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(false);
    expect(onResolved).toHaveBeenCalledWith(cid);
    assertDisjoint(resolver);
  });
});

// --- Disjoint invariant under LRU pressure ---

describe("disjoint invariant under LRU eviction", () => {
  it("rapid puts with tiny LRU: disjoint holds", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();

    const resolver = createDocBlockResolver(
      baseOpts(helia, {
        lruBytes: 3, // tiny: fits ~1 block
        onWriteError,
      }),
    );
    await resolver.ready;

    // Put 8 blocks rapidly — LRU evicts aggressively
    for (let i = 0; i < 8; i++) {
      const data = bytes(i, i + 1, i + 2);
      const cid = await makeCid(data);
      resolver.put(cid, data);
    }

    // Wait for IDB writes to settle
    await vi.waitFor(() => {
      const total = resolver.knownCids.size + resolver.memoryOnlyCids.size;
      expect(total).toBeGreaterThanOrEqual(8);
    });

    assertDisjoint(resolver);
  });

  it("eviction of memoryOnly block cleans both sets", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();

    // All puts fail → all blocks memoryOnly
    helia.blockstore.put = vi
      .fn()
      .mockRejectedValue(
        new Error("QuotaExceeded"),
      ) as typeof helia.blockstore.put;

    const resolver = createDocBlockResolver(
      baseOpts(helia, {
        lruBytes: 4, // fits 1-2 blocks
        onWriteError,
      }),
    );
    await resolver.ready;

    const dataA = bytes(1, 2, 3); // 3 bytes
    const cidA = await makeCid(dataA);
    resolver.put(cidA, dataA);

    await vi.waitFor(() => {
      expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(true);
    });

    // Put a second block that evicts A
    const dataB = bytes(4, 5, 6); // 3 bytes, over 4
    const cidB = await makeCid(dataB);
    resolver.put(cidB, dataB);

    // A evicted from LRU → removed from memoryOnly
    expect(resolver.getCached(cidA)).toBeNull();
    expect(resolver.memoryOnlyCids.has(cidA.toString())).toBe(false);
    expect(resolver.has(cidA)).toBe(false);

    // B still present
    expect(resolver.has(cidB)).toBe(true);
    assertDisjoint(resolver);
  });

  it("eviction of knownCid: has() still true", async () => {
    const helia = createMockHelia();
    const resolver = createDocBlockResolver(baseOpts(helia, { lruBytes: 5 }));
    await resolver.ready;

    const dataA = bytes(1, 2, 3);
    const cidA = await makeCid(dataA);
    resolver.put(cidA, dataA);

    // Wait for IDB persistence
    await vi.waitFor(() => {
      expect(resolver.knownCids.has(cidA.toString())).toBe(true);
    });

    // Evict from LRU by adding larger block
    const dataB = bytes(4, 5, 6);
    const cidB = await makeCid(dataB);
    resolver.put(cidB, dataB);

    // A evicted from LRU but still in knownCids
    expect(resolver.getCached(cidA)).toBeNull();
    expect(resolver.has(cidA)).toBe(true);
    expect(resolver.knownCids.has(cidA.toString())).toBe(true);
    assertDisjoint(resolver);
  });
});

// --- Hydration + concurrent puts ---

describe("hydration + concurrent put races", () => {
  it("put during hydration: both sources populate", async () => {
    const helia = createMockHelia();

    const hydrationData = bytes(10, 20);
    const hydrationCid = await makeCid(hydrationData);

    // Slow hydration that yields after a delay
    async function* enumerate(): AsyncIterable<BlockPair> {
      await new Promise((r) => setTimeout(r, 10));
      yield { cid: hydrationCid, block: hydrationData };
    }

    const resolver = createDocBlockResolver(
      baseOpts(helia, {
        enumeratePersistedCids: enumerate,
      }),
    );

    // Put a block BEFORE hydration completes
    const putData = bytes(30, 40);
    const putCid = await makeCid(putData);
    resolver.put(putCid, putData);

    // Wait for hydration
    await resolver.ready;

    // Both the hydrated CID and the put CID tracked
    expect(resolver.hydrated).toBe(true);
    expect(resolver.knownCids.has(hydrationCid.toString())).toBe(true);
    expect(resolver.has(putCid)).toBe(true);
    assertDisjoint(resolver);
  });

  it("put of hydrated CID updates value in LRU", async () => {
    const helia = createMockHelia();

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

    // CID is in knownCids from hydration but not in LRU
    expect(resolver.has(cid)).toBe(true);
    expect(resolver.getCached(cid)).toBeNull();

    // Put the same CID — adds to LRU
    const newData = bytes(10, 20, 30);
    resolver.put(cid, newData);

    expect(resolver.getCached(cid)).toEqual(newData);
    expect(resolver.has(cid)).toBe(true);
    assertDisjoint(resolver);
  });

  it("hydration error: puts still work", async () => {
    const helia = createMockHelia();

    // eslint-disable-next-line require-yield
    async function* enumerate(): AsyncIterable<BlockPair> {
      throw new Error("IDB corrupted");
    }

    const resolver = createDocBlockResolver(
      baseOpts(helia, {
        enumeratePersistedCids: enumerate,
      }),
    );
    await resolver.ready;

    expect(resolver.hydrated).toBe(true);
    expect(resolver.knownCids.size).toBe(0);

    // Puts still work despite hydration failure
    const data = bytes(50, 60);
    const cid = await makeCid(data);
    resolver.put(cid, data);

    await vi.waitFor(() => {
      expect(resolver.knownCids.has(cid.toString())).toBe(true);
    });

    expect(resolver.has(cid)).toBe(true);
    assertDisjoint(resolver);
  });

  it("many hydrated CIDs + puts: no duplicate tracking", async () => {
    const helia = createMockHelia();
    const hydrationCids: CID[] = [];

    async function* enumerate(): AsyncIterable<BlockPair> {
      for (let i = 0; i < 10; i++) {
        const data = bytes(i);
        const cid = await makeCid(data);
        hydrationCids.push(cid);
        yield { cid, block: data };
      }
    }

    const resolver = createDocBlockResolver(
      baseOpts(helia, {
        enumeratePersistedCids: enumerate,
      }),
    );
    await resolver.ready;

    expect(resolver.knownCids.size).toBe(10);

    // Put some of the same CIDs again
    for (let i = 0; i < 5; i++) {
      resolver.put(hydrationCids[i]!, bytes(i));
    }

    // Also put new CIDs
    for (let i = 100; i < 105; i++) {
      const data = bytes(i);
      const cid = await makeCid(data);
      resolver.put(cid, data);
    }

    await vi.waitFor(() => {
      expect(resolver.knownCids.size).toBe(15);
    });

    // No duplicates — memoryOnly is empty since
    // all puts succeed
    expect(resolver.memoryOnlyCids.size).toBe(0);
    assertDisjoint(resolver);
  });
});

// --- Concurrent async IDB writes ---

describe("concurrent async IDB writes", () => {
  it("multiple rapid puts resolve independently", async () => {
    const helia = createMockHelia();

    // Each put resolves after a random delay
    let putCount = 0;
    helia.blockstore.put = vi.fn((cid: CID, block: Uint8Array) => {
      putCount++;
      const delay = putCount * 5; // stagger
      return new Promise((resolve) => {
        setTimeout(() => {
          helia.store.set(cid.toString(), block);
          resolve(cid);
        }, delay);
      });
    }) as typeof helia.blockstore.put;

    const resolver = createDocBlockResolver(baseOpts(helia));
    await resolver.ready;

    const cids: CID[] = [];
    for (let i = 0; i < 5; i++) {
      const data = bytes(i, i + 10);
      const cid = await makeCid(data);
      cids.push(cid);
      resolver.put(cid, data);
    }

    // All are immediately in LRU
    for (const cid of cids) {
      expect(resolver.has(cid)).toBe(true);
      expect(resolver.getCached(cid)).not.toBeNull();
    }

    // Wait for all IDB writes (last one at ~25ms)
    await vi.waitFor(
      () => {
        expect(resolver.knownCids.size).toBe(5);
      },
      { timeout: 200 },
    );

    assertDisjoint(resolver);
  });

  it("concurrent put of same CID: last write wins", async () => {
    const helia = createMockHelia();
    const resolver = createDocBlockResolver(baseOpts(helia));
    await resolver.ready;

    // Same CID, different data (second is the
    // "updated" version)
    const cid = await makeCid(bytes(1, 2, 3));
    const v1 = bytes(1, 2, 3);
    const v2 = bytes(4, 5, 6, 7);

    resolver.put(cid, v1);
    resolver.put(cid, v2);

    // LRU has latest
    expect(resolver.getCached(cid)).toEqual(v2);

    await vi.waitFor(() => {
      expect(resolver.knownCids.has(cid.toString())).toBe(true);
    });

    assertDisjoint(resolver);
  });
});

// --- Property-based model testing ---

describe("property: model-based state machine", () => {
  // Operations on the resolver tracked by a reference
  // model. After each operation sequence, assert that
  // observable state matches the model.

  type Op =
    | { type: "put"; seed: number }
    | { type: "putFail"; seed: number }
    | { type: "putRecover"; seed: number };

  interface Model {
    /** Seeds whose IDB write succeeded. */
    persisted: Set<number>;
    /** Seeds whose IDB write failed (still in LRU). */
    memoryOnly: Set<number>;
  }

  // Use a generous LRU budget so eviction doesn't
  // complicate the model — eviction is tested above.
  const LRU_BYTES = 10_000;

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      type: fc.constant("put" as const),
      seed: fc.integer({ min: 0, max: 31 }),
    }),
    fc.record({
      type: fc.constant("putFail" as const),
      seed: fc.integer({ min: 0, max: 31 }),
    }),
    fc.record({
      type: fc.constant("putRecover" as const),
      seed: fc.integer({ min: 0, max: 31 }),
    }),
  );

  it(
    "observable state matches reference model",
    { timeout: 30_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(opArb, { minLength: 1, maxLength: 15 }),
          async (ops) => {
            const helia = createMockHelia();
            const resolver = createDocBlockResolver({
              getHelia: () => helia,
              httpUrls: () => [],
              lruBytes: LRU_BYTES,
            });
            await resolver.ready;

            const model: Model = {
              persisted: new Set(),
              memoryOnly: new Set(),
            };

            // Track which seeds have a pending failure
            const failingSeeds = new Set<number>();

            for (const op of ops) {
              const cid = cidCache[op.seed]!;
              const data = cidData[op.seed]!;

              switch (op.type) {
                case "put": {
                  resolver.put(cid, data);
                  // Default mock succeeds
                  model.memoryOnly.delete(op.seed);
                  model.persisted.add(op.seed);
                  break;
                }
                case "putFail": {
                  helia.putFn.mockRejectedValueOnce(new Error("QuotaExceeded"));
                  resolver.put(cid, data);
                  failingSeeds.add(op.seed);
                  // If it was already persisted, the
                  // failure moves it to memoryOnly
                  model.persisted.delete(op.seed);
                  model.memoryOnly.add(op.seed);
                  break;
                }
                case "putRecover": {
                  // Retry with success (default mock)
                  resolver.put(cid, data);
                  model.memoryOnly.delete(op.seed);
                  model.persisted.add(op.seed);
                  break;
                }
              }
            }

            // Wait for all async operations to settle
            const expectedTotal = model.persisted.size + model.memoryOnly.size;

            await vi.waitFor(
              () => {
                const actual =
                  resolver.knownCids.size + resolver.memoryOnlyCids.size;
                expect(actual).toBe(expectedTotal);
              },
              { timeout: 500 },
            );

            // Verify disjoint invariant
            assertDisjoint(resolver);

            // Verify has() matches model
            for (let seed = 0; seed < 32; seed++) {
              const cid = cidCache[seed]!;
              const expected =
                model.persisted.has(seed) || model.memoryOnly.has(seed);
              expect(resolver.has(cid)).toBe(expected);
            }

            // Verify getCached returns data for all
            // tracked seeds (all within LRU budget)
            for (const seed of [...model.persisted, ...model.memoryOnly]) {
              expect(resolver.getCached(cidCache[seed]!)).not.toBeNull();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// --- Edge cases ---

describe("edge cases", () => {
  it("getHelia throws: put still caches in LRU", async () => {
    let shouldThrow = false;
    const helia = createMockHelia();
    const resolver = createDocBlockResolver({
      getHelia: () => {
        if (shouldThrow) throw new Error("no helia");
        return helia;
      },
      httpUrls: () => [],
    });
    await resolver.ready;

    shouldThrow = true;
    const data = bytes(1, 2, 3);
    const cid = await makeCid(data);
    resolver.put(cid, data);

    // Block is in LRU despite IDB failure
    expect(resolver.getCached(cid)).toEqual(data);
    expect(resolver.has(cid)).toBe(true);
    // Marked memoryOnly since persistence threw
    expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
    assertDisjoint(resolver);
  });

  it("onWriteError receives correct CID and error", async () => {
    const helia = createMockHelia();
    const onWriteError = vi.fn();
    const quotaError = new Error("QuotaExceeded");
    helia.putFn.mockRejectedValueOnce(quotaError);

    const resolver = createDocBlockResolver(baseOpts(helia, { onWriteError }));
    await resolver.ready;

    const data = bytes(7, 8, 9);
    const cid = await makeCid(data);
    resolver.put(cid, data);

    await vi.waitFor(() => {
      expect(onWriteError).toHaveBeenCalledTimes(1);
    });

    expect(onWriteError).toHaveBeenCalledWith(cid, quotaError);
  });

  it("onResolved fires exactly once per recovery", async () => {
    const helia = createMockHelia();
    const onResolved = vi.fn();

    // First two puts fail
    helia.putFn
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"));

    const resolver = createDocBlockResolver(baseOpts(helia, { onResolved }));
    await resolver.ready;

    const data = bytes(1, 2);
    const cid = await makeCid(data);

    // Fail twice
    resolver.put(cid, data);
    await vi.waitFor(() => {
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
    });

    resolver.put(cid, data);
    await vi.waitFor(() => {
      // Still memoryOnly after second failure
      expect(resolver.memoryOnlyCids.has(cid.toString())).toBe(true);
    });

    // Third put succeeds
    resolver.put(cid, data);
    await vi.waitFor(() => {
      expect(resolver.knownCids.has(cid.toString())).toBe(true);
    });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(cid);
  });
});
