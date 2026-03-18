/**
 * Property tests for interpreter.ts and feed.ts.
 *
 * Covers shouldAutoFetch policy, Feed reference
 * equality, and createFeed invariants.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { shouldAutoFetch } from "./interpreter.js";
import type { ChainEntry, CidSource } from "./facts.js";
import { createFeed } from "./feed.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// ── Helpers ─────────────────────────────────────

const ALL_SOURCES: CidSource[] = [
  "gossipsub",
  "ipns",
  "http-tip",
  "reannounce",
  "chain-walk",
  "pinner-index",
  "cache",
];

const AUTO_FETCH_SOURCES: CidSource[] = [
  "gossipsub",
  "ipns",
  "http-tip",
  "reannounce",
  "chain-walk",
];

const NON_AUTO_SOURCES: CidSource[] = ["pinner-index", "cache"];

/** Build a minimal ChainEntry for testing. */
function makeEntry(
  sources: CidSource[],
  overrides?: Partial<ChainEntry>,
): ChainEntry {
  // Use a deterministic CID for testing
  const bytes = new Uint8Array(34);
  bytes[0] = 0x12; // sha2-256
  bytes[1] = 0x20; // 32 bytes
  return {
    cid: CID.decode(bytes),
    discoveredVia: new Set(sources),
    blockStatus: "unknown",
    fetchAttempt: 0,
    guarantees: new Map(),
    ackedBy: new Set(),
    ...overrides,
  };
}

// ── shouldAutoFetch ─────────────────────────────

describe("shouldAutoFetch (property)", () => {
  it(
    "returns true when discoveredVia includes " + "any auto-fetch source",
    () => {
      fc.assert(
        fc.property(
          fc.subarray(AUTO_FETCH_SOURCES, {
            minLength: 1,
          }),
          fc.subarray(NON_AUTO_SOURCES),
          (autoSrcs, nonAutoSrcs) => {
            const entry = makeEntry([...autoSrcs, ...nonAutoSrcs]);
            expect(shouldAutoFetch(entry)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it("returns false when discoveredVia has only " + "non-auto sources", () => {
    fc.assert(
      fc.property(
        fc.subarray(NON_AUTO_SOURCES, {
          minLength: 1,
        }),
        (sources) => {
          const entry = makeEntry(sources);
          expect(shouldAutoFetch(entry)).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("returns false for empty discoveredVia", () => {
    const entry = makeEntry([]);
    expect(shouldAutoFetch(entry)).toBe(false);
  });

  it("is pure: same input always gives same " + "output", () => {
    fc.assert(
      fc.property(fc.subarray(ALL_SOURCES), (sources) => {
        const entry = makeEntry(sources);
        const r1 = shouldAutoFetch(entry);
        const r2 = shouldAutoFetch(entry);
        expect(r1).toBe(r2);
      }),
      { numRuns: 100 },
    );
  });

  it(
    "adding an auto-fetch source never makes " + "result go from true to false",
    () => {
      fc.assert(
        fc.property(
          fc.subarray(ALL_SOURCES),
          fc.constantFrom(...AUTO_FETCH_SOURCES),
          (baseSources, extra) => {
            const base = makeEntry(baseSources);
            const extended = makeEntry([...baseSources, extra]);
            // If it was true before adding, it's
            // still true after
            if (shouldAutoFetch(base)) {
              expect(shouldAutoFetch(extended)).toBe(true);
            }
            // After adding auto source, always true
            expect(shouldAutoFetch(extended)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it("each individual auto-fetch source is " + "sufficient alone", () => {
    for (const src of AUTO_FETCH_SOURCES) {
      const entry = makeEntry([src]);
      expect(shouldAutoFetch(entry)).toBe(true);
    }
  });
});

// ── createFeed ──────────────────────────────────

describe("createFeed (property)", () => {
  it("getSnapshot returns initial value before " + "any update", () => {
    fc.assert(
      fc.property(fc.anything(), (init) => {
        const feed = createFeed(init);
        expect(feed.getSnapshot()).toBe(init);
      }),
      { numRuns: 100 },
    );
  });

  it("getSnapshot returns latest value after " + "update", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer(), {
          minLength: 1,
          maxLength: 20,
        }),
        (init, updates) => {
          const feed = createFeed(init);
          for (const v of updates) {
            feed._update(v);
          }
          expect(feed.getSnapshot()).toBe(updates[updates.length - 1]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("no-op update does not notify subscribers", () => {
    fc.assert(
      fc.property(fc.integer(), (val) => {
        const feed = createFeed(val);
        let calls = 0;
        feed.subscribe(() => {
          calls++;
        });

        // Update to same value — should be no-op
        feed._update(val);
        expect(calls).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("different value always notifies subscribers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 1000, max: 1999 }),
        (init, different) => {
          const feed = createFeed(init);
          let calls = 0;
          feed.subscribe(() => {
            calls++;
          });

          feed._update(different);
          expect(calls).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("unsubscribe prevents further notifications", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.array(fc.integer({ min: 1000, max: 9999 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (init, updates) => {
          const feed = createFeed(init);
          let calls = 0;
          const unsub = feed.subscribe(() => {
            calls++;
          });

          unsub();

          for (const v of updates) {
            feed._update(v);
          }
          expect(calls).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("custom equality function controls " + "notification", () => {
    // Use modular equality: values equal if
    // they have the same remainder mod 10
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 1, max: 100 }),
        (init, multiplier) => {
          const feed = createFeed(init, (a, b) => a % 10 === b % 10);
          let calls = 0;
          feed.subscribe(() => {
            calls++;
          });

          // Same modular value — should not notify
          feed._update(init + 10 * multiplier);
          expect(calls).toBe(0);

          // Different modular value — should notify
          const diff = (init + 1) % 10;
          feed._update(diff);
          expect(calls).toBe(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("multiple subscribers all get notified", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 1000, max: 1999 }),
        (subCount, init, newVal) => {
          const feed = createFeed(init);
          const counts: number[] = [];

          for (let i = 0; i < subCount; i++) {
            counts.push(0);
            const idx = i;
            feed.subscribe(() => {
              counts[idx]++;
            });
          }

          feed._update(newVal);
          for (let i = 0; i < subCount; i++) {
            expect(counts[i]).toBe(1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
