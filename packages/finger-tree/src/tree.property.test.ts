import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Monoid, Measured } from "./monoid.js";
import {
  empty,
  singleton,
  cons,
  snoc,
  measureTree,
  viewl,
  viewr,
} from "./tree.js";
import { concat } from "./concat.js";
import { split } from "./split.js";
import { toArray, fromArray, foldr, foldl, iterate } from "./fold.js";

// ---- Test monoids ----

// Commutative: additive
const addM: Measured<number, number> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (x) => x,
};

// Non-commutative: semidirect product
// MA(a,x) <> MA(b,y) = MA(a*b, x + a*y)
interface MA {
  a: number;
  x: number;
}
const semiM: Monoid<MA> = {
  empty: { a: 1, x: 0 },
  append: (l, r) => ({
    a: l.a * r.a,
    x: l.x + l.a * r.x,
  }),
};
const semiMeasured: Measured<MA, number> = {
  monoid: semiM,
  measure: (n) => ({ a: n, x: n }),
};

const eqMA = (a: MA, b: MA) => a.a === b.a && a.x === b.x;

// ---- Arbitraries ----

const arbSmallInts = fc.array(fc.integer({ min: -5, max: 5 }), {
  minLength: 0,
  maxLength: 30,
});

// ---- Helpers ----

function foldMonoid<V>(
  monoid: Monoid<V>,
  measure: (a: number) => V,
  xs: number[],
): V {
  return xs.reduce((acc, x) => monoid.append(acc, measure(x)), monoid.empty);
}

// ---- Tests ----

describe("finger tree algebraic laws", () => {
  // -- Deque laws --

  it("cons(x, t) prepends x", () => {
    fc.assert(
      fc.property(fc.integer(), arbSmallInts, (x, xs) => {
        const t = fromArray(addM, xs);
        expect(toArray(cons(addM, x, t))).toEqual([x, ...xs]);
      }),
      { numRuns: 500 },
    );
  });

  it("snoc(t, x) appends x", () => {
    fc.assert(
      fc.property(arbSmallInts, fc.integer(), (xs, x) => {
        const t = fromArray(addM, xs);
        expect(toArray(snoc(addM, t, x))).toEqual([...xs, x]);
      }),
      { numRuns: 500 },
    );
  });

  it("viewl yields head + tail", () => {
    fc.assert(
      fc.property(
        arbSmallInts.filter((xs) => xs.length > 0),
        (xs) => {
          const t = fromArray(addM, xs);
          const v = viewl(addM, t);
          expect(v).toBeDefined();
          expect(v!.head).toBe(xs[0]);
          expect(toArray(v!.tail)).toEqual(xs.slice(1));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("viewr yields init + last", () => {
    fc.assert(
      fc.property(
        arbSmallInts.filter((xs) => xs.length > 0),
        (xs) => {
          const t = fromArray(addM, xs);
          const v = viewr(addM, t);
          expect(v).toBeDefined();
          expect(v!.last).toBe(xs[xs.length - 1]);
          expect(toArray(v!.init)).toEqual(xs.slice(0, -1));
        },
      ),
      { numRuns: 500 },
    );
  });

  // -- Roundtrip --

  it("toArray(fromArray(xs)) === xs", () => {
    fc.assert(
      fc.property(arbSmallInts, (xs) => {
        expect(toArray(fromArray(addM, xs))).toEqual(xs);
      }),
      { numRuns: 500 },
    );
  });

  // -- Measure consistency --

  it("measure(t) === fold of element measures", () => {
    fc.assert(
      fc.property(arbSmallInts, (xs) => {
        const t = fromArray(addM, xs);
        const expected = xs.reduce((a, b) => a + b, 0);
        expect(measureTree(addM, t)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("measure consistent with non-commutative " + "monoid", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3, max: 3 }), {
          minLength: 0,
          maxLength: 20,
        }),
        (xs) => {
          const t = fromArray(semiMeasured, xs);
          const expected = foldMonoid(semiM, semiMeasured.measure, xs);
          expect(eqMA(measureTree(semiMeasured, t), expected)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("measure(cons(x, t)) === " + "append(measure(x), measure(t))", () => {
    fc.assert(
      fc.property(fc.integer(), arbSmallInts, (x, xs) => {
        const t = fromArray(addM, xs);
        const consed = cons(addM, x, t);
        expect(measureTree(addM, consed)).toBe(
          addM.monoid.append(addM.measure(x), measureTree(addM, t)),
        );
      }),
      { numRuns: 500 },
    );
  });

  // -- Concat --

  it("concat preserves elements with " + "non-commutative monoid", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3, max: 3 }), {
          minLength: 0,
          maxLength: 15,
        }),
        fc.array(fc.integer({ min: -3, max: 3 }), {
          minLength: 0,
          maxLength: 15,
        }),
        (xs, ys) => {
          const a = fromArray(semiMeasured, xs);
          const b = fromArray(semiMeasured, ys);
          const c = concat(semiMeasured, a, b);
          expect(toArray(c)).toEqual([...xs, ...ys]);
          const expected = foldMonoid(semiM, semiMeasured.measure, [
            ...xs,
            ...ys,
          ]);
          expect(eqMA(measureTree(semiMeasured, c), expected)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  // -- Split with counting monoid --

  it("split+concat roundtrip", () => {
    const countM: Measured<number, number> = {
      monoid: { empty: 0, append: (a, b) => a + b },
      measure: () => 1,
    };
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3, max: 3 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.nat(),
        (xs, raw) => {
          const n = (raw % xs.length) + 1;
          const t = fromArray(countM, xs);
          const { left, value, right } = split(countM, (v) => v >= n, t)!;
          expect(
            toArray(concat(countM, snoc(countM, left, value), right)),
          ).toEqual(xs);
        },
      ),
      { numRuns: 500 },
    );
  });

  // -- Fold laws --

  it("foldr matches array reduceRight", () => {
    fc.assert(
      fc.property(arbSmallInts, (xs) => {
        const t = fromArray(addM, xs);
        const result = foldr(t, (a, b) => a - b, 0);
        const expected = [...xs].reduceRight((b, a) => a - b, 0);
        expect(result).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("foldl matches array reduce", () => {
    fc.assert(
      fc.property(arbSmallInts, (xs) => {
        const t = fromArray(addM, xs);
        const result = foldl(t, (b, a) => b - a, 0);
        const expected = xs.reduce((b, a) => b - a, 0);
        expect(result).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  // -- Structural validity --

  it("cached measure correct after arbitrary ops", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant("cons" as const),
              val: fc.integer({ min: -5, max: 5 }),
            }),
            fc.record({
              op: fc.constant("snoc" as const),
              val: fc.integer({ min: -5, max: 5 }),
            }),
          ),
          { minLength: 0, maxLength: 40 },
        ),
        (ops) => {
          let t = empty<number, number>();
          const expected: number[] = [];
          for (const { op, val } of ops) {
            if (op === "cons") {
              t = cons(addM, val, t);
              expected.unshift(val);
            } else {
              t = snoc(addM, t, val);
              expected.push(val);
            }
          }
          expect(measureTree(addM, t)).toBe(
            expected.reduce((a, b) => a + b, 0),
          );
          expect(toArray(t)).toEqual(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  // -- Iterator --

  it("iterate yields same elements as toArray", () => {
    fc.assert(
      fc.property(arbSmallInts, (xs) => {
        const t = fromArray(addM, xs);
        expect([...iterate(t)]).toEqual(toArray(t));
      }),
      { numRuns: 500 },
    );
  });
});
