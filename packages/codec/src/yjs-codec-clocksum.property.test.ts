/**
 * Property tests for yjsCodec.clockSum.
 *
 * Verifies:
 * - Monotonicity: applying any edit produces
 *   clockSum >= previous clockSum
 * - Additivity: clockSum(merge(a, b)) equals
 *   sum of individual clockSums when inputs are
 *   from independent clients
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { yjsCodec as codec } from "./yjs-codec.js";

// -- Arbitrary Yjs updates --

/**
 * Generate an arbitrary Yjs update from a fresh doc
 * (single client ID).
 */
function arbUpdate(): fc.Arbitrary<Uint8Array> {
  return fc
    .array(
      fc.tuple(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.oneof(fc.integer(), fc.string({ maxLength: 20 })),
      ),
      { minLength: 1, maxLength: 10 },
    )
    .map((entries) => {
      const doc = new Y.Doc();
      const map = doc.getMap("test");
      for (const [k, v] of entries) {
        map.set(k, v);
      }
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    });
}

/**
 * Generate a pair of independent updates from
 * different client IDs (no shared clocks).
 */
function arbIndependentPair(): fc.Arbitrary<[Uint8Array, Uint8Array]> {
  return fc
    .tuple(
      fc.array(
        fc.tuple(
          fc.string({
            minLength: 1,
            maxLength: 8,
          }),
          fc.integer(),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      fc.array(
        fc.tuple(
          fc.string({
            minLength: 1,
            maxLength: 8,
          }),
          fc.integer(),
        ),
        { minLength: 1, maxLength: 5 },
      ),
    )
    .map(([entries1, entries2]) => {
      const doc1 = new Y.Doc();
      const map1 = doc1.getMap("test");
      for (const [k, v] of entries1) {
        map1.set(k, v);
      }
      const u1 = Y.encodeStateAsUpdate(doc1);
      doc1.destroy();

      const doc2 = new Y.Doc();
      const map2 = doc2.getMap("test");
      for (const [k, v] of entries2) {
        map2.set(k, v);
      }
      const u2 = Y.encodeStateAsUpdate(doc2);
      doc2.destroy();

      return [u1, u2] as [Uint8Array, Uint8Array];
    });
}

// -- Property tests --

describe("clockSum properties", () => {
  it("monotonicity: apply never decreases", () => {
    fc.assert(
      fc.property(arbUpdate(), arbUpdate(), (base, edit) => {
        const merged = codec.apply(base, edit);
        expect(codec.clockSum(merged)).toBeGreaterThanOrEqual(
          codec.clockSum(base),
        );
      }),
      { numRuns: 50 },
    );
  });

  it(
    "monotonicity: merge never decreases " + "relative to either input",
    () => {
      fc.assert(
        fc.property(arbUpdate(), arbUpdate(), (a, b) => {
          const merged = codec.merge(a, b);
          const sumMerged = codec.clockSum(merged);
          expect(sumMerged).toBeGreaterThanOrEqual(codec.clockSum(a));
          expect(sumMerged).toBeGreaterThanOrEqual(codec.clockSum(b));
        }),
        { numRuns: 50 },
      );
    },
  );

  it("additivity: independent clients sum " + "exactly", () => {
    fc.assert(
      fc.property(arbIndependentPair(), ([a, b]) => {
        const merged = codec.merge(a, b);
        const sumA = codec.clockSum(a);
        const sumB = codec.clockSum(b);
        const sumMerged = codec.clockSum(merged);
        // Independent docs have disjoint client
        // IDs, so clockSum should be additive.
        expect(sumMerged).toBe(sumA + sumB);
      }),
      { numRuns: 50 },
    );
  });

  it("empty state has clockSum 0", () => {
    expect(codec.clockSum(codec.empty())).toBe(0);
  });

  it("idempotence: merge(a, a) has same " + "clockSum as a", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        const merged = codec.merge(a, a);
        expect(codec.clockSum(merged)).toBe(codec.clockSum(a));
      }),
      { numRuns: 50 },
    );
  });
});
