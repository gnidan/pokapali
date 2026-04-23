/**
 * D1: Property tests for BlockResolver.has().
 *
 * Uses fast-check to generate random sequences of
 * put / evict / loss / failure-inject operations
 * and asserts that has() invariants hold throughout.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createStubBlockResolver } from "./stub-block-resolver.js";

const DAG_CBOR = 0x71;

// ── Arbitraries ──────────────────────────────────

/**
 * Generate a deterministic CID from a seed byte.
 * Pre-computed outside property runs for speed.
 */
const cidCache = new Map<number, CID>();

async function cidFromSeed(seed: number): Promise<CID> {
  const cached = cidCache.get(seed);
  if (cached) return cached;
  const data = new Uint8Array([seed]);
  const hash = await sha256.digest(data);
  const cid = CID.createV1(DAG_CBOR, hash);
  cidCache.set(seed, cid);
  return cid;
}

/** Pre-warm the CID cache for seeds 0–255. */
async function warmCidCache(): Promise<void> {
  await Promise.all(Array.from({ length: 256 }, (_, i) => cidFromSeed(i)));
}

/** Seed byte arbitrary (0–63 for reasonable
 *  collision rate in operations). */
const seedArb = fc.integer({ min: 0, max: 63 });

/** Operation model for driving the resolver. */
type Op =
  | { type: "put"; seed: number }
  | { type: "evict"; seed: number }
  | { type: "loss"; seed: number }
  | { type: "failOnce" }
  | { type: "failPersistent" }
  | { type: "clearFailure" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: seedArb.map((s) => ({ type: "put" as const, seed: s })),
  },
  {
    weight: 2,
    arbitrary: seedArb.map((s) => ({ type: "evict" as const, seed: s })),
  },
  {
    weight: 1,
    arbitrary: seedArb.map((s) => ({ type: "loss" as const, seed: s })),
  },
  { weight: 1, arbitrary: fc.constant({ type: "failOnce" as const }) },
  { weight: 1, arbitrary: fc.constant({ type: "failPersistent" as const }) },
  { weight: 1, arbitrary: fc.constant({ type: "clearFailure" as const }) },
);

// ── Model ────────────────────────────────────────

/**
 * Reference model tracking expected has() results.
 * Mirrors the two-tier stub logic without relying
 * on stub internals — if the model and stub agree,
 * the contract is satisfied.
 */
interface Model {
  memory: Set<number>;
  persistence: Set<number>;
  failMode: "none" | "once" | "persistent";
}

function applyOp(model: Model, op: Op): void {
  switch (op.type) {
    case "put": {
      model.memory.add(op.seed);
      if (model.failMode === "none") {
        model.persistence.add(op.seed);
      } else if (model.failMode === "once") {
        // Memory-only; one-shot clears.
        model.failMode = "none";
      }
      // persistent failure: memory-only, stays
      break;
    }
    case "evict": {
      model.memory.delete(op.seed);
      break;
    }
    case "loss": {
      model.memory.delete(op.seed);
      model.persistence.delete(op.seed);
      break;
    }
    case "failOnce": {
      model.failMode = "once";
      break;
    }
    case "failPersistent": {
      model.failMode = "persistent";
      break;
    }
    case "clearFailure": {
      model.failMode = "none";
      break;
    }
  }
}

function modelHas(model: Model, seed: number): boolean {
  return model.memory.has(seed) || model.persistence.has(seed);
}

function modelGetCached(model: Model, seed: number): boolean {
  return model.memory.has(seed);
}

// ── Tests ────────────────────────────────────────

describe("BlockResolver.has() properties", () => {
  // Warm the CID cache before all properties.
  // fast-check runs sync but our CID generation is
  // async, so we pre-compute all 64 CIDs.
  it("setup: warm CID cache", async () => {
    await warmCidCache();
  });

  it(
    "has() agrees with reference model after " +
      "arbitrary operation sequences",
    () => {
      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 50 }), (ops) => {
          const resolver = createStubBlockResolver();
          const model: Model = {
            memory: new Set(),
            persistence: new Set(),
            failMode: "none",
          };

          for (const op of ops) {
            // Apply to reference model.
            applyOp(model, op);

            // Apply to stub.
            const cid = "seed" in op ? cidCache.get(op.seed)! : undefined;
            const data = "seed" in op ? new Uint8Array([op.seed]) : undefined;

            switch (op.type) {
              case "put":
                resolver.put(cid!, data!);
                break;
              case "evict":
                resolver.simulateMemoryEviction(cid!);
                break;
              case "loss":
                resolver.simulateBlockLoss(cid!);
                break;
              case "failOnce":
                resolver.simulatePutFailure("quota");
                break;
              case "failPersistent":
                resolver.simulatePersistentPutFailure("unavailable");
                break;
              case "clearFailure":
                resolver.clearPutFailure();
                break;
            }
          }

          // Assert: has() matches model for ALL seeds
          // in the pool (not just touched ones).
          for (let seed = 0; seed < 64; seed++) {
            const cid = cidCache.get(seed)!;
            const expected = modelHas(model, seed);
            expect(resolver.has(cid)).toBe(expected);
          }
        }),
        { numRuns: 500 },
      );
    },
  );

  it("has() is synchronous: returns boolean, " + "not a thenable", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const resolver = createStubBlockResolver();
        const cid = cidCache.get(seed)!;

        // Before put: synchronous false.
        const before = resolver.has(cid);
        expect(typeof before).toBe("boolean");
        expect(before).toBe(false);

        // After put: synchronous true (same tick).
        resolver.put(cid, new Uint8Array([seed]));
        const after = resolver.has(cid);
        expect(typeof after).toBe("boolean");
        expect(after).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("has(cid) true + not evicted ⇒ " + "getCached(cid) non-null", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const resolver = createStubBlockResolver();
        const model: Model = {
          memory: new Set(),
          persistence: new Set(),
          failMode: "none",
        };

        for (const op of ops) {
          applyOp(model, op);

          const cid = "seed" in op ? cidCache.get(op.seed)! : undefined;
          const data = "seed" in op ? new Uint8Array([op.seed]) : undefined;

          switch (op.type) {
            case "put":
              resolver.put(cid!, data!);
              break;
            case "evict":
              resolver.simulateMemoryEviction(cid!);
              break;
            case "loss":
              resolver.simulateBlockLoss(cid!);
              break;
            case "failOnce":
              resolver.simulatePutFailure("quota");
              break;
            case "failPersistent":
              resolver.simulatePersistentPutFailure("unavailable");
              break;
            case "clearFailure":
              resolver.clearPutFailure();
              break;
          }
        }

        // For every seed: if has() true AND in
        // memory, getCached must return bytes.
        for (let seed = 0; seed < 64; seed++) {
          const cid = cidCache.get(seed)!;
          if (resolver.has(cid) && modelGetCached(model, seed)) {
            expect(resolver.getCached(cid)).not.toBeNull();
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("storedCids mirrors has() for all " + "touched seeds", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const resolver = createStubBlockResolver();

        for (const op of ops) {
          const cid = "seed" in op ? cidCache.get(op.seed)! : undefined;
          const data = "seed" in op ? new Uint8Array([op.seed]) : undefined;

          switch (op.type) {
            case "put":
              resolver.put(cid!, data!);
              break;
            case "evict":
              resolver.simulateMemoryEviction(cid!);
              break;
            case "loss":
              resolver.simulateBlockLoss(cid!);
              break;
            case "failOnce":
              resolver.simulatePutFailure("quota");
              break;
            case "failPersistent":
              resolver.simulatePersistentPutFailure("unavailable");
              break;
            case "clearFailure":
              resolver.clearPutFailure();
              break;
          }
        }

        // storedCids membership ≡ has() for
        // every seed in the pool.
        for (let seed = 0; seed < 64; seed++) {
          const cid = cidCache.get(seed)!;
          const key = cid.toString();
          expect(resolver.storedCids.has(key)).toBe(resolver.has(cid));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("has() false for CIDs never added", () => {
    fc.assert(
      fc.property(
        fc.array(
          seedArb
            .filter((s) => s < 32)
            .map((s) => ({ type: "put" as const, seed: s })),
          { minLength: 0, maxLength: 20 },
        ),
        (puts) => {
          const resolver = createStubBlockResolver();
          for (const op of puts) {
            resolver.put(cidCache.get(op.seed)!, new Uint8Array([op.seed]));
          }

          // Seeds 32–63 were never added.
          for (let seed = 32; seed < 64; seed++) {
            expect(resolver.has(cidCache.get(seed)!)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it(
    "put under failure ⇒ has() true, " +
      "then eviction ⇒ has() false " +
      "(memory-only block lost)",
    () => {
      fc.assert(
        fc.property(seedArb, (seed) => {
          const resolver = createStubBlockResolver();
          const cid = cidCache.get(seed)!;
          const data = new Uint8Array([seed]);

          // Put under failure: memory-only.
          resolver.simulatePutFailure("quota");
          resolver.put(cid, data);
          expect(resolver.has(cid)).toBe(true);

          // Evict memory: block is gone entirely.
          resolver.simulateMemoryEviction(cid);
          expect(resolver.has(cid)).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );
});
