import type { Measured } from "./monoid.js";
import type { FingerTree, Node, Digit } from "./types.js";
import { digitToArray, digitMeasure } from "./digit.js";
import { nodeMeasured, nodeToArray } from "./node.js";
import { empty, cons, measureTree, viewl, viewr } from "./tree.js";
import { fromArray } from "./fold.js";

export interface Split<V, A> {
  readonly left: FingerTree<V, A>;
  readonly value: A;
  readonly right: FingerTree<V, A>;
}

/**
 * Split the tree at the point where predicate p first
 * becomes true on the accumulated measure.
 *
 * Preconditions:
 * - p is monotonic (once true, stays true)
 * - p(monoid.empty) is false
 *
 * Returns undefined if p(measure(tree)) is false
 * (predicate never satisfied).
 */
export function split<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  t: FingerTree<V, A>,
): Split<V, A> | undefined {
  if (t.tag === "empty") return undefined;
  if (!p(measureTree(m, t))) return undefined;
  return splitTree(m, p, m.monoid.empty, t);
}

/**
 * Elements before the split point.
 */
export function takeUntil<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  t: FingerTree<V, A>,
): FingerTree<V, A> {
  const s = split(m, p, t);
  return s === undefined ? t : s.left;
}

/**
 * Split-point element and everything after.
 */
export function dropUntil<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  t: FingerTree<V, A>,
): FingerTree<V, A> {
  const s = split(m, p, t);
  return s === undefined ? empty() : cons(m, s.value, s.right);
}

// -- Internal --

function splitTree<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  acc: V,
  t: FingerTree<V, A>,
): Split<V, A> {
  if (t.tag === "single") {
    return {
      left: empty(),
      value: t.a,
      right: empty(),
    };
  }

  if (t.tag === "empty") {
    throw new Error("splitTree called on empty tree");
  }

  // t is deep
  const { prefix, middle, suffix } = t;

  // Check prefix
  const prefixM = digitMeasure(m, prefix);
  const accPr = m.monoid.append(acc, prefixM);
  if (p(accPr)) {
    const ds = splitDigit(m, p, acc, prefix);
    const leftTree = fromArray(m, ds.left);
    const rightTree = deepL(
      m,
      ds.right,
      middle as FingerTree<V, Node<V, A>>,
      suffix,
    );
    return {
      left: leftTree,
      value: ds.value,
      right: rightTree,
    };
  }

  // Check middle
  const nm = nodeMeasured(m);
  const middleTyped = middle as FingerTree<V, Node<V, A>>;
  const middleM = measureTree(nm, middleTyped);
  const accMid = m.monoid.append(accPr, middleM);
  if (p(accMid)) {
    const ms = splitTree(nm, p, accPr, middleTyped);
    const nodeArr = nodeToArray(ms.value);
    const accLeft = m.monoid.append(accPr, measureTree(nm, ms.left));
    const ds = splitDigitArr(m, p, accLeft, nodeArr);
    const leftTree = deepR(m, prefix, ms.left, ds.left);
    const rightTree = deepL(m, ds.right, ms.right, suffix);
    return {
      left: leftTree,
      value: ds.value,
      right: rightTree,
    };
  }

  // Must be in suffix
  const ds = splitDigit(m, p, accMid, suffix);
  const leftTree = deepR(m, prefix, middleTyped, ds.left);
  const rightTree = fromArray(m, ds.right);
  return {
    left: leftTree,
    value: ds.value,
    right: rightTree,
  };
}

interface DigitSplit<A> {
  left: A[];
  value: A;
  right: A[];
}

function splitDigit<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  acc: V,
  d: Digit<A>,
): DigitSplit<A> {
  return splitDigitArr(m, p, acc, digitToArray(d));
}

function splitDigitArr<V, A>(
  m: Measured<V, A>,
  p: (v: V) => boolean,
  acc: V,
  xs: A[],
): DigitSplit<A> {
  let running = acc;
  for (let i = 0; i < xs.length; i++) {
    const next = m.monoid.append(running, m.measure(xs[i]!));
    if (p(next)) {
      return {
        left: xs.slice(0, i),
        value: xs[i]!,
        right: xs.slice(i + 1),
      };
    }
    running = next;
  }
  // Should not reach here if preconditions hold
  return {
    left: xs.slice(0, -1),
    value: xs[xs.length - 1]!,
    right: [],
  };
}

// Smart constructor: build tree from prefix elements,
// middle tree, and suffix digit
function deepL<V, A>(
  m: Measured<V, A>,
  prefixArr: A[],
  middle: FingerTree<V, Node<V, A>>,
  suffix: Digit<A>,
): FingerTree<V, A> {
  if (prefixArr.length === 0) {
    const nm = nodeMeasured(m);
    const v = viewl(nm, middle);
    if (v === undefined) {
      return digitToTree(m, suffix);
    }
    return mkDeep(
      m,
      nodeToDigit(v.head),
      v.tail as FingerTree<V, unknown>,
      suffix,
    );
  }
  return mkDeep(
    m,
    arrToDigit(prefixArr),
    middle as FingerTree<V, unknown>,
    suffix,
  );
}

function deepR<V, A>(
  m: Measured<V, A>,
  prefix: Digit<A>,
  middle: FingerTree<V, Node<V, A>>,
  suffixArr: A[],
): FingerTree<V, A> {
  if (suffixArr.length === 0) {
    const nm = nodeMeasured(m);
    const v = viewr(nm, middle);
    if (v === undefined) {
      return digitToTree(m, prefix);
    }
    return mkDeep(
      m,
      prefix,
      v.init as FingerTree<V, unknown>,
      nodeToDigit(v.last),
    );
  }
  return mkDeep(
    m,
    prefix,
    middle as FingerTree<V, unknown>,
    arrToDigit(suffixArr),
  );
}

function mkDeep<V, A>(
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

function arrToDigit<A>(xs: A[]): Digit<A> {
  switch (xs.length) {
    case 1:
      return { tag: "one", a: xs[0]! };
    case 2:
      return { tag: "two", a: xs[0]!, b: xs[1]! };
    case 3:
      return {
        tag: "three",
        a: xs[0]!,
        b: xs[1]!,
        c: xs[2]!,
      };
    case 4:
      return {
        tag: "four",
        a: xs[0]!,
        b: xs[1]!,
        c: xs[2]!,
        d: xs[3]!,
      };
    default:
      throw new Error(`Invalid digit length: ${xs.length}`);
  }
}

function nodeToDigit<V, A>(node: Node<V, A>): Digit<A> {
  return node.tag === "node2"
    ? { tag: "two", a: node.a, b: node.b }
    : {
        tag: "three",
        a: node.a,
        b: node.b,
        c: node.c,
      };
}

function digitToTree<V, A>(m: Measured<V, A>, d: Digit<A>): FingerTree<V, A> {
  const arr = digitToArray(d);
  return fromArray(m, arr);
}
