import type { Measured } from "./monoid.js";
import type { FingerTree, Node, Digit } from "./types.js";
import {
  digitMeasure,
  digitHead,
  digitTail,
  digitLast,
  digitInit,
  one,
  two,
  three,
} from "./digit.js";
import { node3, nodeMeasured, nodeToArray } from "./node.js";

// -- Construction --

export function empty<V, A>(): FingerTree<V, A> {
  return { tag: "empty" };
}

export function singleton<V, A>(a: A): FingerTree<V, A> {
  return { tag: "single", a };
}

export function isEmpty<V, A>(t: FingerTree<V, A>): boolean {
  return t.tag === "empty";
}

// -- Measure --

export function measureTree<V, A>(m: Measured<V, A>, t: FingerTree<V, A>): V {
  switch (t.tag) {
    case "empty":
      return m.monoid.empty;
    case "single":
      return m.measure(t.a);
    case "deep":
      return t.v;
  }
}

// -- Smart constructor --

function deep<V, A>(
  m: Measured<V, A>,
  prefix: Digit<A>,
  middle: FingerTree<V, unknown>,
  suffix: Digit<A>,
): FingerTree<V, A> {
  const nm = nodeMeasured(m);
  const v = m.monoid.append(
    m.monoid.append(
      digitMeasure(m, prefix),
      measureTree(nm, middle as FingerTree<V, Node<V, A>>),
    ),
    digitMeasure(m, suffix),
  );
  return { tag: "deep", v, prefix, middle, suffix };
}

// -- cons --

export function cons<V, A>(
  m: Measured<V, A>,
  a: A,
  t: FingerTree<V, A>,
): FingerTree<V, A> {
  switch (t.tag) {
    case "empty":
      return singleton(a);
    case "single":
      return deep(m, one(a), empty(), one(t.a));
    case "deep": {
      const pr = t.prefix;
      if (pr.tag !== "four") {
        return deep(m, consDigitUnsafe(a, pr), t.middle, t.suffix);
      }
      // Digit overflow: push node3 into middle
      const nm = nodeMeasured(m);
      const n = node3(m, pr.b, pr.c, pr.d);
      const newMiddle = cons(
        nm,
        n,
        t.middle as FingerTree<V, Node<V, A>>,
      ) as FingerTree<V, unknown>;
      return deep(m, two(a, pr.a), newMiddle, t.suffix);
    }
  }
}

// Prepend to a non-Four digit (caller guarantees)
function consDigitUnsafe<A>(a: A, d: Digit<A>): Digit<A> {
  switch (d.tag) {
    case "one":
      return two(a, d.a);
    case "two":
      return three(a, d.a, d.b);
    case "three":
      return { tag: "four", a, b: d.a, c: d.b, d: d.c };
    case "four":
      throw new Error("unreachable");
  }
}

// -- snoc --

export function snoc<V, A>(
  m: Measured<V, A>,
  t: FingerTree<V, A>,
  a: A,
): FingerTree<V, A> {
  switch (t.tag) {
    case "empty":
      return singleton(a);
    case "single":
      return deep(m, one(t.a), empty(), one(a));
    case "deep": {
      const sf = t.suffix;
      if (sf.tag !== "four") {
        return deep(m, t.prefix, t.middle, snocDigitUnsafe(sf, a));
      }
      // Digit overflow: push node3 into middle
      const nm = nodeMeasured(m);
      const n = node3(m, sf.a, sf.b, sf.c);
      const newMiddle = snoc(
        nm,
        t.middle as FingerTree<V, Node<V, A>>,
        n,
      ) as FingerTree<V, unknown>;
      return deep(m, t.prefix, newMiddle, two(sf.d, a));
    }
  }
}

// Append to a non-Four digit (caller guarantees)
function snocDigitUnsafe<A>(d: Digit<A>, a: A): Digit<A> {
  switch (d.tag) {
    case "one":
      return two(d.a, a);
    case "two":
      return three(d.a, d.b, a);
    case "three":
      return { tag: "four", a: d.a, b: d.b, c: d.c, d: a };
    case "four":
      throw new Error("unreachable");
  }
}

// -- viewl --

export function viewl<V, A>(
  m: Measured<V, A>,
  t: FingerTree<V, A>,
): { head: A; tail: FingerTree<V, A> } | undefined {
  switch (t.tag) {
    case "empty":
      return undefined;
    case "single":
      return { head: t.a, tail: empty() };
    case "deep": {
      const h = digitHead(t.prefix);
      const tail = deepL(
        m,
        t.prefix.tag === "one" ? undefined : digitTail(t.prefix),
        t.middle as FingerTree<V, Node<V, A>>,
        t.suffix,
      );
      return { head: h, tail };
    }
  }
}

// Smart constructor: when prefix is empty, pull
// from middle
function deepL<V, A>(
  m: Measured<V, A>,
  prefix: Digit<A> | undefined,
  middle: FingerTree<V, Node<V, A>>,
  suffix: Digit<A>,
): FingerTree<V, A> {
  if (prefix !== undefined) {
    return deep(m, prefix, middle as FingerTree<V, unknown>, suffix);
  }
  const nm = nodeMeasured(m);
  const v = viewl(nm, middle);
  if (v === undefined) {
    // Middle is empty — promote suffix
    return digitToTree(m, suffix);
  }
  const newPrefix = nodeToDigit(v.head);
  return deep(m, newPrefix, v.tail as FingerTree<V, unknown>, suffix);
}

// -- viewr --

export function viewr<V, A>(
  m: Measured<V, A>,
  t: FingerTree<V, A>,
): { init: FingerTree<V, A>; last: A } | undefined {
  switch (t.tag) {
    case "empty":
      return undefined;
    case "single":
      return { init: empty(), last: t.a };
    case "deep": {
      const l = digitLast(t.suffix);
      const init = deepR(
        m,
        t.prefix,
        t.middle as FingerTree<V, Node<V, A>>,
        t.suffix.tag === "one" ? undefined : digitInit(t.suffix),
      );
      return { init, last: l };
    }
  }
}

// Smart constructor: when suffix is empty, pull
// from middle
function deepR<V, A>(
  m: Measured<V, A>,
  prefix: Digit<A>,
  middle: FingerTree<V, Node<V, A>>,
  suffix: Digit<A> | undefined,
): FingerTree<V, A> {
  if (suffix !== undefined) {
    return deep(m, prefix, middle as FingerTree<V, unknown>, suffix);
  }
  const nm = nodeMeasured(m);
  const v = viewr(nm, middle);
  if (v === undefined) {
    // Middle is empty — promote prefix
    return digitToTree(m, prefix);
  }
  const newSuffix = nodeToDigit(v.last);
  return deep(m, prefix, v.init as FingerTree<V, unknown>, newSuffix);
}

// -- head / last --

export function head<V, A>(t: FingerTree<V, A>): A | undefined {
  switch (t.tag) {
    case "empty":
      return undefined;
    case "single":
      return t.a;
    case "deep":
      return digitHead(t.prefix);
  }
}

export function last<V, A>(t: FingerTree<V, A>): A | undefined {
  switch (t.tag) {
    case "empty":
      return undefined;
    case "single":
      return t.a;
    case "deep":
      return digitLast(t.suffix);
  }
}

// -- Helpers --

function nodeToDigit<V, A>(node: Node<V, A>): Digit<A> {
  return node.tag === "node2"
    ? two(node.a, node.b)
    : three(node.a, node.b, node.c);
}

function digitToTree<V, A>(m: Measured<V, A>, d: Digit<A>): FingerTree<V, A> {
  switch (d.tag) {
    case "one":
      return singleton(d.a);
    case "two":
      return deep(m, one(d.a), empty(), one(d.b));
    case "three":
      return deep(m, two(d.a, d.b), empty(), one(d.c));
    case "four":
      return deep(m, two(d.a, d.b), empty(), two(d.c, d.d));
  }
}
