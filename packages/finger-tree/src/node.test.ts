import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { node2, node3, nodeToArray } from "./node.js";
import type { Measured } from "./monoid.js";

const sizeM: Measured<number, string> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (s) => s.length,
};

describe("Node", () => {
  it("node2 caches correct measure", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const n = node2(sizeM, a, b);
        expect(n.v).toBe(a.length + b.length);
      }),
      { numRuns: 200 },
    );
  });

  it("node3 caches correct measure", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (a, b, c) => {
        const n = node3(sizeM, a, b, c);
        expect(n.v).toBe(a.length + b.length + c.length);
      }),
      { numRuns: 200 },
    );
  });

  it("nodeToArray preserves elements in order", () => {
    const n2 = node2(sizeM, "a", "b");
    expect(nodeToArray(n2)).toEqual(["a", "b"]);

    const n3 = node3(sizeM, "a", "b", "c");
    expect(nodeToArray(n3)).toEqual(["a", "b", "c"]);
  });
});
