import type { Measured } from "./monoid.js";
import type { FingerTree, Node, Digit } from "./types.js";
import { digitToArray, digitMeasure } from "./digit.js";
import { node2, node3, nodeMeasured } from "./node.js";
import { empty, cons, snoc, measureTree } from "./tree.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("finger-tree");

/**
 * Concatenate two finger trees.
 */
export function concat<V, A>(
  m: Measured<V, A>,
  left: FingerTree<V, A>,
  right: FingerTree<V, A>,
): FingerTree<V, A> {
  return app3(m, left, [], right);
}

/**
 * Core concatenation: left ++ mid ++ right.
 * Hinze & Paterson's app3.
 */
function app3<V, A>(
  m: Measured<V, A>,
  left: FingerTree<V, A>,
  mid: A[],
  right: FingerTree<V, A>,
): FingerTree<V, A> {
  // left is empty: cons mid onto right
  if (left.tag === "empty") {
    let t = right;
    for (let i = mid.length - 1; i >= 0; i--) {
      t = cons(m, mid[i]!, t);
    }
    return t;
  }

  // right is empty: snoc mid onto left
  if (right.tag === "empty") {
    let t: FingerTree<V, A> = left;
    for (const x of mid) {
      t = snoc(m, t, x);
    }
    return t;
  }

  // left is single: cons its element, then recurse
  if (left.tag === "single") {
    return cons(m, left.a, app3(m, empty(), mid, right));
  }

  // right is single: snoc its element, then recurse
  if (right.tag === "single") {
    return snoc(m, app3(m, left, mid, empty()), right.a);
  }

  // Both deep: merge inner digits through middle
  log.debug("concat: merging two deep trees");
  const nm = nodeMeasured(m);
  const combined = [
    ...digitToArray(left.suffix),
    ...mid,
    ...digitToArray(right.prefix),
  ];
  const ns = nodes(m, combined);
  const newMiddle = app3(
    nm,
    left.middle as FingerTree<V, Node<V, A>>,
    ns,
    right.middle as FingerTree<V, Node<V, A>>,
  ) as FingerTree<V, unknown>;

  const v = m.monoid.append(
    m.monoid.append(
      digitMeasure(m, left.prefix),
      measureTree(nm, newMiddle as FingerTree<V, Node<V, A>>),
    ),
    digitMeasure(m, right.suffix),
  );

  return {
    tag: "deep",
    v,
    prefix: left.prefix,
    middle: newMiddle,
    suffix: right.suffix,
  };
}

/**
 * Pack a list of 2+ elements into Node2/Node3 values.
 */
function nodes<V, A>(m: Measured<V, A>, xs: A[]): Node<V, A>[] {
  const len = xs.length;
  if (len === 2) {
    return [node2(m, xs[0]!, xs[1]!)];
  }
  if (len === 3) {
    return [node3(m, xs[0]!, xs[1]!, xs[2]!)];
  }
  if (len === 4) {
    return [node2(m, xs[0]!, xs[1]!), node2(m, xs[2]!, xs[3]!)];
  }
  // len >= 5: take 3, recurse on rest
  return [node3(m, xs[0]!, xs[1]!, xs[2]!), ...nodes(m, xs.slice(3))];
}
