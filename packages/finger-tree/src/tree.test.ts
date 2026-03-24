import { describe, it, expect } from "vitest";
import {
  empty,
  singleton,
  cons,
  snoc,
  measureTree,
  isEmpty,
  viewl,
  viewr,
  head,
  last,
} from "./tree.js";
import { toArray, fromArray } from "./fold.js";
import type { Measured } from "./monoid.js";

const sizeM: Measured<number, string> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (s) => s.length,
};

describe("tree basics", () => {
  it("empty tree has identity measure", () => {
    expect(measureTree(sizeM, empty<number, string>())).toBe(0);
  });

  it("isEmpty on empty tree", () => {
    expect(isEmpty(empty())).toBe(true);
    expect(isEmpty(singleton("x"))).toBe(false);
  });

  it("singleton has element's measure", () => {
    const t = singleton<number, string>("hello");
    expect(measureTree(sizeM, t)).toBe(5);
  });

  it("cons builds from left", () => {
    let t = empty<number, string>();
    t = cons(sizeM, "a", t);
    t = cons(sizeM, "bb", t);
    t = cons(sizeM, "ccc", t);
    expect(measureTree(sizeM, t)).toBe(6);
  });

  it("snoc builds from right", () => {
    let t = empty<number, string>();
    t = snoc(sizeM, t, "a");
    t = snoc(sizeM, t, "bb");
    t = snoc(sizeM, t, "ccc");
    expect(measureTree(sizeM, t)).toBe(6);
  });

  it("cons handles digit overflow (>4 elements)", () => {
    let t = empty<number, string>();
    for (let i = 0; i < 20; i++) {
      t = cons(sizeM, String(i), t);
    }
    expect(measureTree(sizeM, t)).toBe(
      Array.from({ length: 20 }, (_, i) => String(i).length).reduce(
        (a, b) => a + b,
        0,
      ),
    );
  });

  it("snoc handles digit overflow (>4 elements)", () => {
    let t = empty<number, string>();
    for (let i = 0; i < 20; i++) {
      t = snoc(sizeM, t, String(i));
    }
    expect(measureTree(sizeM, t)).toBe(
      Array.from({ length: 20 }, (_, i) => String(i).length).reduce(
        (a, b) => a + b,
        0,
      ),
    );
  });
});

describe("viewl / viewr / head / last", () => {
  it("viewl on empty returns undefined", () => {
    expect(viewl(sizeM, empty())).toBeUndefined();
  });

  it("viewr on empty returns undefined", () => {
    expect(viewr(sizeM, empty())).toBeUndefined();
  });

  it("head on empty returns undefined", () => {
    expect(head(empty())).toBeUndefined();
  });

  it("last on empty returns undefined", () => {
    expect(last(empty())).toBeUndefined();
  });

  it("viewl on singleton", () => {
    const v = viewl(sizeM, singleton("x"));
    expect(v).toBeDefined();
    expect(v!.head).toBe("x");
    expect(isEmpty(v!.tail)).toBe(true);
  });

  it("viewr on singleton", () => {
    const v = viewr(sizeM, singleton("x"));
    expect(v).toBeDefined();
    expect(v!.last).toBe("x");
    expect(isEmpty(v!.init)).toBe(true);
  });

  it("head/last on multi-element tree", () => {
    let t = empty<number, string>();
    t = snoc(sizeM, t, "first");
    t = snoc(sizeM, t, "mid");
    t = snoc(sizeM, t, "last");
    expect(head(t)).toBe("first");
    expect(last(t)).toBe("last");
  });

  it("viewl decomposes correctly", () => {
    let t = empty<number, string>();
    t = snoc(sizeM, t, "a");
    t = snoc(sizeM, t, "bb");
    t = snoc(sizeM, t, "ccc");
    const v = viewl(sizeM, t)!;
    expect(v.head).toBe("a");
    expect(measureTree(sizeM, v.tail)).toBe(5);
  });

  it("viewr decomposes correctly", () => {
    let t = empty<number, string>();
    t = snoc(sizeM, t, "a");
    t = snoc(sizeM, t, "bb");
    t = snoc(sizeM, t, "ccc");
    const v = viewr(sizeM, t)!;
    expect(v.last).toBe("ccc");
    expect(measureTree(sizeM, v.init)).toBe(3);
  });

  it("repeated viewl drains tree", () => {
    let t = empty<number, string>();
    for (let i = 0; i < 10; i++) {
      t = snoc(sizeM, t, String(i));
    }
    const elements: string[] = [];
    let current = t;
    while (!isEmpty(current)) {
      const v = viewl(sizeM, current)!;
      elements.push(v.head);
      current = v.tail;
    }
    expect(elements).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
  });

  it("repeated viewr drains tree in reverse", () => {
    let t = empty<number, string>();
    for (let i = 0; i < 10; i++) {
      t = snoc(sizeM, t, String(i));
    }
    const elements: string[] = [];
    let current = t;
    while (!isEmpty(current)) {
      const v = viewr(sizeM, current)!;
      elements.push(v.last);
      current = v.init;
    }
    expect(elements).toEqual(
      Array.from({ length: 10 }, (_, i) => String(9 - i)),
    );
  });
});

describe("toArray / fromArray", () => {
  it("empty tree → empty array", () => {
    expect(toArray(empty())).toEqual([]);
  });

  it("singleton round-trips", () => {
    const t = singleton("x");
    expect(toArray(t)).toEqual(["x"]);
  });

  it("cons builds in correct order", () => {
    let t = empty<number, string>();
    t = cons(sizeM, "a", t);
    t = cons(sizeM, "b", t);
    t = cons(sizeM, "c", t);
    expect(toArray(t)).toEqual(["c", "b", "a"]);
  });

  it("snoc builds in correct order", () => {
    let t = empty<number, string>();
    t = snoc(sizeM, t, "a");
    t = snoc(sizeM, t, "b");
    t = snoc(sizeM, t, "c");
    expect(toArray(t)).toEqual(["a", "b", "c"]);
  });

  it("fromArray round-trips", () => {
    const arr = ["a", "bb", "ccc", "dddd", "eeeee"];
    const t = fromArray(sizeM, arr);
    expect(toArray(t)).toEqual(arr);
    expect(measureTree(sizeM, t)).toBe(15);
  });

  it("large fromArray round-trips", () => {
    const arr = Array.from({ length: 100 }, (_, i) => String(i));
    const t = fromArray(sizeM, arr);
    expect(toArray(t)).toEqual(arr);
  });
});
