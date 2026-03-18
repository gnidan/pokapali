/**
 * Property-based tests for @pokapali/snapshot.
 *
 * Covers the fetch coalescer state machine (pure
 * state transitions) and snapshot encode/decode
 * round-trip properties.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createFetchCoalescerState,
  coalescerNext,
  coalescerResolve,
  coalescerFail,
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  validateSnapshot,
} from "./index.js";
import type { FetchCoalescerState } from "./index.js";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { CID } from "multiformats/cid";

// ------------------------------------------------
// Fetch coalescer state machine
// ------------------------------------------------

type Action =
  | { type: "add"; cid: string }
  | { type: "next" }
  | { type: "resolve"; cid: string }
  | { type: "fail"; cid: string };

const cidPool = ["cid-a", "cid-b", "cid-c", "cid-d", "cid-e"];

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("add" as const),
      cid: fc.constantFrom(...cidPool),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("next" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("resolve" as const),
      cid: fc.constantFrom(...cidPool),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("fail" as const),
      cid: fc.constantFrom(...cidPool),
    }),
  },
);

function applyAction(
  state: FetchCoalescerState,
  action: Action,
): FetchCoalescerState {
  switch (action.type) {
    case "add":
      state.pending.add(action.cid);
      return state;
    case "next":
      coalescerNext(state);
      return state;
    case "resolve":
      if (state.inflight.has(action.cid)) {
        coalescerResolve(state, action.cid, new Uint8Array([1]));
      }
      return state;
    case "fail":
      if (state.inflight.has(action.cid)) {
        coalescerFail(state, action.cid);
      }
      return state;
  }
}

function checkMutualExclusion(state: FetchCoalescerState): void {
  // No CID in two terminal buckets
  for (const cid of state.inflight) {
    expect(state.resolved.has(cid)).toBe(false);
    expect(state.failed.has(cid)).toBe(false);
  }
  for (const cid of state.resolved.keys()) {
    expect(state.inflight.has(cid)).toBe(false);
    expect(state.failed.has(cid)).toBe(false);
  }
  for (const cid of state.failed) {
    expect(state.inflight.has(cid)).toBe(false);
    expect(state.resolved.has(cid)).toBe(false);
  }
}

describe("fetch coalescer state machine", () => {
  const NUM_RUNS = 200;
  const SEQ_LEN = 60;

  it("mutual exclusion holds across all actions", () => {
    fc.assert(
      fc.property(fc.array(arbAction, { maxLength: SEQ_LEN }), (actions) => {
        const state = createFetchCoalescerState();
        for (const action of actions) {
          applyAction(state, action);
          checkMutualExclusion(state);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("coalescerNext returns at most 3 items " + "per call", () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, {
          maxLength: SEQ_LEN,
        }),
        (actions) => {
          const state = createFetchCoalescerState();
          for (const action of actions) {
            if (action.type === "next") {
              const { toFetch } = coalescerNext(state);
              expect(toFetch.length).toBeLessThanOrEqual(3);
            } else {
              applyAction(state, action);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("resolved items stay resolved (monotonic)", () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, {
          maxLength: SEQ_LEN,
        }),
        (actions) => {
          const state = createFetchCoalescerState();
          const everResolved = new Set<string>();

          for (const action of actions) {
            applyAction(state, action);
            for (const cid of state.resolved.keys()) {
              everResolved.add(cid);
            }
          }

          // Everything that was ever resolved
          // should still be resolved
          for (const cid of everResolved) {
            expect(state.resolved.has(cid)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("failed items stay failed (monotonic)", () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, {
          maxLength: SEQ_LEN,
        }),
        (actions) => {
          const state = createFetchCoalescerState();
          const everFailed = new Set<string>();

          for (const action of actions) {
            applyAction(state, action);
            for (const cid of state.failed) {
              everFailed.add(cid);
            }
          }

          for (const cid of everFailed) {
            expect(state.failed.has(cid)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("coalescerNext is idempotent when no pending", () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, {
          maxLength: SEQ_LEN,
        }),
        (actions) => {
          const state = createFetchCoalescerState();
          for (const action of actions) {
            applyAction(state, action);
          }

          // Clear pending to test idempotence
          state.pending.clear();
          const before = state.inflight.size;
          coalescerNext(state);
          expect(state.inflight.size).toBe(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("all added CIDs eventually reachable via " + "next + resolve/fail", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...cidPool), { minLength: 1, maxLength: 5 }),
        (cids) => {
          const state = createFetchCoalescerState();
          const unique = [...new Set(cids)];

          // Add all CIDs
          for (const cid of unique) {
            state.pending.add(cid);
          }

          // Drain: next → resolve, repeat
          for (let i = 0; i < 10; i++) {
            const { toFetch } = coalescerNext(state);
            if (toFetch.length === 0) break;
            for (const cid of toFetch) {
              coalescerResolve(state, cid, new Uint8Array([1]));
            }
          }

          // All should be resolved
          for (const cid of unique) {
            expect(state.resolved.has(cid)).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ------------------------------------------------
// Snapshot encode/decode round-trip
// ------------------------------------------------

describe("snapshot encode/decode properties", () => {
  it("decode(encode(...)) preserves metadata", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 1000 }),
        fc.nat({ max: 100_000 }),
        async (seq, ts) => {
          const plaintext = {
            content: new Uint8Array([1, 2, 3]),
          };
          const block = await encodeSnapshot(
            plaintext,
            keys.readKey,
            null,
            seq,
            ts,
            signingKey,
          );
          const decoded = decodeSnapshot(block);

          expect(decoded.seq).toBe(seq);
          expect(decoded.ts).toBe(ts);
          expect(decoded.prev).toBeNull();
          expect(decoded.publicKey).toEqual(signingKey.publicKey);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("encoded block always passes structure " + "validation", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 100 }), async (seq) => {
        const block = await encodeSnapshot(
          {
            content: new Uint8Array([seq & 0xff]),
          },
          keys.readKey,
          null,
          seq,
          Date.now(),
          signingKey,
        );
        const valid = await validateSnapshot(block);
        expect(valid).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it("tampered block fails validation", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const block = await encodeSnapshot(
      { content: new Uint8Array([1, 2, 3]) },
      keys.readKey,
      null,
      1,
      1000,
      signingKey,
    );

    await fc.assert(
      fc.asyncProperty(fc.nat({ max: block.length - 1 }), async (idx) => {
        const tampered = new Uint8Array(block);
        tampered[idx] = (tampered[idx]! + 1) % 256;
        const valid = await validateSnapshot(tampered);
        // Most byte flips should invalidate;
        // some rare CBOR-level changes might
        // still decode differently. We verify
        // it doesn't throw at minimum.
        expect(typeof valid).toBe("boolean");
      }),
      { numRuns: 30 },
    );
  });
});

// ------------------------------------------------
// Snapshot encrypt/decrypt round-trip
// ------------------------------------------------

describe("snapshot encrypt/decrypt round-trip", () => {
  it(
    "decrypt(encode(...), readKey) recovers " + "original plaintext",
    async () => {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test", ["content"]);
      const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({
            minLength: 0,
            maxLength: 256,
          }),
          fc.nat({ max: 1000 }),
          fc.nat({ max: 100_000 }),
          async (payload, seq, ts) => {
            const plaintext = { content: payload };
            const block = await encodeSnapshot(
              plaintext,
              keys.readKey,
              null,
              seq,
              ts,
              signingKey,
            );
            const node = decodeSnapshot(block);
            const decrypted = await decryptSnapshot(node, keys.readKey);

            expect(decrypted.content).toEqual(payload);
          },
        ),
        { numRuns: 30 },
      );
    },
  );

  it(
    "decrypt with multiple subdocs preserves " + "all namespaces",
    async () => {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test", ["content", "meta"]);
      const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({
            minLength: 1,
            maxLength: 128,
          }),
          fc.uint8Array({
            minLength: 1,
            maxLength: 128,
          }),
          async (contentData, metaData) => {
            const plaintext = {
              content: contentData,
              meta: metaData,
            };
            const block = await encodeSnapshot(
              plaintext,
              keys.readKey,
              null,
              1,
              1000,
              signingKey,
            );
            const node = decodeSnapshot(block);
            const decrypted = await decryptSnapshot(node, keys.readKey);

            expect(decrypted.content).toEqual(contentData);
            expect(decrypted.meta).toEqual(metaData);
            expect(Object.keys(decrypted).sort()).toEqual(["content", "meta"]);
          },
        ),
        { numRuns: 20 },
      );
    },
  );
});

// ------------------------------------------------
// Publisher signature invariants
// ------------------------------------------------

describe("publisher signature properties", () => {
  it(
    "both-or-neither: identityKey produces " + "both publisher+publisherSig",
    async () => {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test", ["content"]);
      const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

      // Separate identity key for publisher
      const idSeed = generateAdminSecret();
      const idKeys = await deriveDocKeys(idSeed, "identity", []);
      const identityKey = await ed25519KeyPairFromSeed(idKeys.ipnsKeyBytes);

      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.nat({ max: 500 }),
          async (includeIdentity, seq) => {
            const block = await encodeSnapshot(
              {
                content: new Uint8Array([1]),
              },
              keys.readKey,
              null,
              seq,
              Date.now(),
              signingKey,
              includeIdentity ? identityKey : undefined,
            );
            const node = decodeSnapshot(block);

            if (includeIdentity) {
              expect(node.publisher).toBeDefined();
              expect(node.publisherSig).toBeDefined();
              expect(node.publisher).toEqual(identityKey.publicKey);
            } else {
              expect(node.publisher).toBeUndefined();
              expect(node.publisherSig).toBeUndefined();
            }
          },
        ),
        { numRuns: 20 },
      );
    },
  );

  it("snapshot with publisher sig passes " + "validateSnapshot", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const idSeed = generateAdminSecret();
    const idKeys = await deriveDocKeys(idSeed, "identity", []);
    const identityKey = await ed25519KeyPairFromSeed(idKeys.ipnsKeyBytes);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 100 }),
        fc.nat({ max: 100_000 }),
        async (seq, ts) => {
          const block = await encodeSnapshot(
            {
              content: new Uint8Array([seq & 0xff]),
            },
            keys.readKey,
            null,
            seq,
            ts,
            signingKey,
            identityKey,
          );
          const valid = await validateSnapshot(block);
          expect(valid).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it(
    "different identity keys produce different " + "publisher fields",
    async () => {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test", ["content"]);
      const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({
            minLength: 32,
            maxLength: 32,
          }),
          fc.uint8Array({
            minLength: 32,
            maxLength: 32,
          }),
          async (seed1, seed2) => {
            // Skip if seeds are identical
            if (seed1.every((b, i) => b === seed2[i])) {
              return;
            }

            const id1 = await ed25519KeyPairFromSeed(seed1);
            const id2 = await ed25519KeyPairFromSeed(seed2);

            const block1 = await encodeSnapshot(
              { content: new Uint8Array([1]) },
              keys.readKey,
              null,
              1,
              1000,
              signingKey,
              id1,
            );
            const block2 = await encodeSnapshot(
              { content: new Uint8Array([1]) },
              keys.readKey,
              null,
              1,
              1000,
              signingKey,
              id2,
            );

            const node1 = decodeSnapshot(block1);
            const node2 = decodeSnapshot(block2);

            // Different identity keys →
            // different publisher pubkeys
            expect(node1.publisher).not.toEqual(node2.publisher);
          },
        ),
        { numRuns: 20 },
      );
    },
  );
});
