import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { concat } from "./concat.js";
import { toArray, fromArray } from "./fold.js";
import { empty, measureTree } from "./tree.js";
import type { Measured } from "./monoid.js";

const sizeM: Measured<number, string> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (s) => s.length,
};

const arbArr = fc.array(fc.string({ minLength: 0, maxLength: 5 }), {
  minLength: 0,
  maxLength: 50,
});

describe("concat properties", () => {
  it("toArray(concat(a, b)) === " + "[...toArray(a), ...toArray(b)]", () => {
    fc.assert(
      fc.property(arbArr, arbArr, (xs, ys) => {
        const a = fromArray(sizeM, xs);
        const b = fromArray(sizeM, ys);
        const result = toArray(concat(sizeM, a, b));
        expect(result).toEqual([...xs, ...ys]);
      }),
      { numRuns: 500 },
    );
  });

  it("measure(concat(a, b)) === " + "append(measure(a), measure(b))", () => {
    fc.assert(
      fc.property(arbArr, arbArr, (xs, ys) => {
        const a = fromArray(sizeM, xs);
        const b = fromArray(sizeM, ys);
        const c = concat(sizeM, a, b);
        expect(measureTree(sizeM, c)).toBe(
          sizeM.monoid.append(measureTree(sizeM, a), measureTree(sizeM, b)),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("left identity: concat(empty, t) ≡ t", () => {
    fc.assert(
      fc.property(arbArr, (xs) => {
        const t = fromArray(sizeM, xs);
        const result = concat(sizeM, empty(), t);
        expect(toArray(result)).toEqual(xs);
      }),
      { numRuns: 200 },
    );
  });

  it("right identity: concat(t, empty) ≡ t", () => {
    fc.assert(
      fc.property(arbArr, (xs) => {
        const t = fromArray(sizeM, xs);
        const result = concat(sizeM, t, empty());
        expect(toArray(result)).toEqual(xs);
      }),
      { numRuns: 200 },
    );
  });

  it(
    "associativity: concat(concat(a,b),c) ≡ " + "concat(a,concat(b,c))",
    () => {
      fc.assert(
        fc.property(arbArr, arbArr, arbArr, (xs, ys, zs) => {
          const a = fromArray(sizeM, xs);
          const b = fromArray(sizeM, ys);
          const c = fromArray(sizeM, zs);
          const left = concat(sizeM, concat(sizeM, a, b), c);
          const right = concat(sizeM, a, concat(sizeM, b, c));
          expect(toArray(left)).toEqual(toArray(right));
        }),
        { numRuns: 300 },
      );
    },
  );
});
