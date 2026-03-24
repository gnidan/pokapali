import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Monoid } from "./monoid.js";
import { combine } from "./monoid.js";

// Helper: assert monoid laws for a given monoid +
// arbitrary
export function assertMonoidLaws<V>(
  name: string,
  monoid: Monoid<V>,
  arb: fc.Arbitrary<V>,
  eq: (a: V, b: V) => boolean = (a, b) =>
    JSON.stringify(a) === JSON.stringify(b),
) {
  describe(`${name} monoid laws`, () => {
    it("left identity: append(empty, v) === v", () => {
      fc.assert(
        fc.property(arb, (v) => {
          expect(eq(monoid.append(monoid.empty, v), v)).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it("right identity: append(v, empty) === v", () => {
      fc.assert(
        fc.property(arb, (v) => {
          expect(eq(monoid.append(v, monoid.empty), v)).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it(
      "associativity: append(append(a,b),c)" + " === append(a,append(b,c))",
      () => {
        fc.assert(
          fc.property(arb, arb, arb, (a, b, c) => {
            expect(
              eq(
                monoid.append(monoid.append(a, b), c),
                monoid.append(a, monoid.append(b, c)),
              ),
            ).toBe(true);
          }),
          { numRuns: 200 },
        );
      },
    );
  });
}

// Validate with the additive monoid
const additive: Monoid<number> = {
  empty: 0,
  append: (a, b) => a + b,
};

assertMonoidLaws("additive", additive, fc.integer());

// Non-commutative monoid: semidirect product
// MA(a, x) <> MA(b, y) = MA(a*b, x + a*y)
interface MA {
  a: number;
  x: number;
}

const semidirect: Monoid<MA> = {
  empty: { a: 1, x: 0 },
  append: (l, r) => ({
    a: l.a * r.a,
    x: l.x + l.a * r.x,
  }),
};

const arbMA = fc.record({
  a: fc.integer({ min: -10, max: 10 }),
  x: fc.integer({ min: -100, max: 100 }),
});

const eqMA = (a: MA, b: MA) => a.a === b.a && a.x === b.x;

assertMonoidLaws("semidirect (non-commutative)", semidirect, arbMA, eqMA);

describe("combine", () => {
  it("assembles a product monoid from components", () => {
    const product = combine({
      sum: {
        empty: 0,
        append: (a: number, b: number) => a + b,
      },
      max: {
        empty: -Infinity,
        append: (a: number, b: number) => Math.max(a, b),
      },
    });

    expect(product.empty).toEqual({
      sum: 0,
      max: -Infinity,
    });
    expect(product.append({ sum: 3, max: 5 }, { sum: 7, max: 2 })).toEqual({
      sum: 10,
      max: 5,
    });
  });

  it("satisfies monoid laws", () => {
    const product = combine({
      sum: {
        empty: 0,
        append: (a: number, b: number) => a + b,
      },
      all: {
        empty: true,
        append: (a: boolean, b: boolean) => a && b,
      },
    });

    const arb = fc.record({
      sum: fc.integer({ min: -100, max: 100 }),
      all: fc.boolean(),
    });

    assertMonoidLaws(
      "product (sum × all)",
      product,
      arb,
      (a, b) => a.sum === b.sum && a.all === b.all,
    );
  });
});
