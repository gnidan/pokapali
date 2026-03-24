import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { split, takeUntil, dropUntil } from "./split.js";
import { concat } from "./concat.js";
import { toArray, fromArray } from "./fold.js";
import { cons, snoc, measureTree } from "./tree.js";
import type { Measured } from "./monoid.js";

// Count monoid: measure = 1 per element
const countM: Measured<number, unknown> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: () => 1,
};

const arbArr = fc.array(fc.integer({ min: 0, max: 100 }), {
  minLength: 0,
  maxLength: 50,
});

describe("split properties", () => {
  it("split roundtrip: " + "[...left, value, ...right] ≡ original", () => {
    fc.assert(
      fc.property(
        arbArr.filter((xs) => xs.length > 0),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const result = split(countM, (v) => v >= n, t);
          expect(result).toBeDefined();
          const { left, value, right } = result!;
          const rebuilt = toArray(
            concat(countM, snoc(countM, left, value), right),
          );
          expect(rebuilt).toEqual(xs);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("split at index n yields correct parts", () => {
    fc.assert(
      fc.property(
        arbArr.filter((xs) => xs.length > 0),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const result = split(countM, (v) => v >= n, t);
          expect(result).toBeDefined();
          const { left, value, right } = result!;
          expect(toArray(left)).toEqual(xs.slice(0, n - 1));
          expect(value).toBe(xs[n - 1]);
          expect(toArray(right)).toEqual(xs.slice(n));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("takeUntil(p, t) ≡ split(p, t).left", () => {
    fc.assert(
      fc.property(
        arbArr.filter((xs) => xs.length > 0),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const p = (v: number) => v >= n;
          const taken = toArray(takeUntil(countM, p, t));
          const { left } = split(countM, p, t)!;
          expect(taken).toEqual(toArray(left));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("dropUntil(p, t) ≡ " + "cons(split.value, split.right)", () => {
    fc.assert(
      fc.property(
        arbArr.filter((xs) => xs.length > 0),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const p = (v: number) => v >= n;
          const dropped = toArray(dropUntil(countM, p, t));
          const { value, right } = split(countM, p, t)!;
          expect(dropped).toEqual(toArray(cons(countM, value, right)));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("left measure is n-1 at split point", () => {
    fc.assert(
      fc.property(
        arbArr.filter((xs) => xs.length > 0),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const { left } = split(countM, (v) => v >= n, t)!;
          expect(measureTree(countM, left)).toBe(n - 1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
