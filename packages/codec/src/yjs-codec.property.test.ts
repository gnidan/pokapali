/**
 * Property tests for yjsCodec.
 *
 * Verifies CRDT laws hold for arbitrary inputs:
 * - merge commutativity
 * - merge associativity
 * - merge idempotence
 * - merge identity (empty)
 * - diff/apply roundtrip
 * - contains after merge
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { yjsCodec as codec } from "./yjs-codec.js";

// -- Arbitrary Yjs updates --

/**
 * Generate an arbitrary Yjs update by creating a
 * doc with random map entries.
 */
function arbUpdate(): fc.Arbitrary<Uint8Array> {
  return fc
    .record({
      entries: fc.array(
        fc.tuple(
          fc.string({
            minLength: 1,
            maxLength: 8,
          }),
          fc.oneof(fc.integer(), fc.string({ maxLength: 20 })),
        ),
        { minLength: 1, maxLength: 10 },
      ),
    })
    .map(({ entries }) => {
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
 * Read all values from a Yjs update's "test" map.
 */
function readMap(update: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const map = doc.getMap("test");
  const result: Record<string, unknown> = {};
  map.forEach((v, k) => {
    result[k] = v;
  });
  doc.destroy();
  return result;
}

// -- Property tests --

describe("CRDT law properties", () => {
  it("merge is commutative", () => {
    fc.assert(
      fc.property(arbUpdate(), arbUpdate(), (a, b) => {
        const ab = readMap(codec.merge(a, b));
        const ba = readMap(codec.merge(b, a));
        expect(ab).toEqual(ba);
      }),
      { numRuns: 50 },
    );
  });

  it("merge is associative", () => {
    fc.assert(
      fc.property(arbUpdate(), arbUpdate(), arbUpdate(), (a, b, c) => {
        const ab_c = readMap(codec.merge(codec.merge(a, b), c));
        const a_bc = readMap(codec.merge(a, codec.merge(b, c)));
        expect(ab_c).toEqual(a_bc);
      }),
      { numRuns: 50 },
    );
  });

  it("merge is idempotent", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        const aa = readMap(codec.merge(a, a));
        const just_a = readMap(a);
        expect(aa).toEqual(just_a);
      }),
      { numRuns: 50 },
    );
  });

  it("empty is merge identity", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        const ae = readMap(codec.merge(a, codec.empty()));
        const ea = readMap(codec.merge(codec.empty(), a));
        const just_a = readMap(a);
        expect(ae).toEqual(just_a);
        expect(ea).toEqual(just_a);
      }),
      { numRuns: 50 },
    );
  });
});

describe("diff/apply properties", () => {
  it("apply(base, diff(full, base)) = full", () => {
    fc.assert(
      fc.property(arbUpdate(), arbUpdate(), (a, b) => {
        // Build "full" by merging a and b via apply
        const full = codec.apply(a, b);
        const delta = codec.diff(full, a);
        const result = codec.apply(a, delta);
        expect(readMap(result)).toEqual(readMap(full));
      }),
      { numRuns: 50 },
    );
  });

  it("diff(a, a) produces no new ops", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        const d = codec.diff(a, a);
        // Applying self-diff shouldn't change state
        const result = codec.apply(a, d);
        expect(readMap(result)).toEqual(readMap(a));
      }),
      { numRuns: 50 },
    );
  });
});

describe("contains properties", () => {
  it("merge(a, b) contains both a and b", () => {
    fc.assert(
      fc.property(arbUpdate(), arbUpdate(), (a, b) => {
        const merged = codec.merge(a, b);
        expect(codec.contains(merged, a)).toBe(true);
        expect(codec.contains(merged, b)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("a always contains empty", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        expect(codec.contains(a, codec.empty())).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("a contains itself", () => {
    fc.assert(
      fc.property(arbUpdate(), (a) => {
        expect(codec.contains(a, a)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
