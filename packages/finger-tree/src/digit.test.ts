import { describe, it, expect } from "vitest";
import {
  one,
  two,
  three,
  four,
  digitToArray,
  digitMeasure,
  consDigit,
  snocDigit,
} from "./digit.js";
import type { Measured } from "./monoid.js";

const sizeM: Measured<number, string> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (s) => s.length,
};

describe("Digit", () => {
  it("digitToArray preserves order", () => {
    expect(digitToArray(one("a"))).toEqual(["a"]);
    expect(digitToArray(two("a", "b"))).toEqual(["a", "b"]);
    expect(digitToArray(three("a", "b", "c"))).toEqual(["a", "b", "c"]);
    expect(digitToArray(four("a", "b", "c", "d"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("digitMeasure folds element measures", () => {
    expect(digitMeasure(sizeM, one("hi"))).toBe(2);
    expect(digitMeasure(sizeM, two("hi", "bye"))).toBe(5);
    expect(digitMeasure(sizeM, three("a", "bb", "ccc"))).toBe(6);
  });

  it("consDigit prepends", () => {
    const d = consDigit("x", two("a", "b"));
    expect(digitToArray(d)).toEqual(["x", "a", "b"]);
  });

  it("snocDigit appends", () => {
    const d = snocDigit(two("a", "b"), "x");
    expect(digitToArray(d)).toEqual(["a", "b", "x"]);
  });
});
