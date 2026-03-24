import type { Measured } from "./monoid.js";
import type { FingerTree, Digit, Node } from "./types.js";
import { digitToArray } from "./digit.js";
import { nodeToArray } from "./node.js";
import { empty, snoc } from "./tree.js";

/**
 * Convert a finger tree to an array (left-to-right).
 */
export function toArray<V, A>(tree: FingerTree<V, A>): A[] {
  const result: A[] = [];
  pushTree(tree, 0, result as unknown[]);
  return result;
}

// Walk the tree, tracking nesting depth. At depth 0,
// elements are leaf values. At depth > 0, each element
// is a Node wrapping values at depth-1.
function pushTree(
  tree: FingerTree<unknown, unknown>,
  depth: number,
  out: unknown[],
): void {
  switch (tree.tag) {
    case "empty":
      return;
    case "single":
      pushElement(tree.a, depth, out);
      return;
    case "deep": {
      pushDigitElements(tree.prefix, depth, out);
      pushTree(tree.middle, depth + 1, out);
      pushDigitElements(tree.suffix, depth, out);
    }
  }
}

function pushElement(x: unknown, depth: number, out: unknown[]): void {
  if (depth === 0) {
    out.push(x);
  } else {
    const node = x as Node<unknown, unknown>;
    for (const child of nodeToArray(node)) {
      pushElement(child, depth - 1, out);
    }
  }
}

function pushDigitElements(
  d: Digit<unknown>,
  depth: number,
  out: unknown[],
): void {
  for (const x of digitToArray(d)) {
    pushElement(x, depth, out);
  }
}

/**
 * Build a finger tree from an array.
 */
export function fromArray<V, A>(
  m: Measured<V, A>,
  xs: readonly A[],
): FingerTree<V, A> {
  let t = empty<V, A>();
  for (const x of xs) {
    t = snoc(m, t, x);
  }
  return t;
}

/**
 * Right fold over tree elements.
 */
export function foldr<V, A, B>(
  tree: FingerTree<V, A>,
  f: (a: A, b: B) => B,
  z: B,
): B {
  const arr = toArray(tree);
  let acc = z;
  for (let i = arr.length - 1; i >= 0; i--) {
    acc = f(arr[i]!, acc);
  }
  return acc;
}

/**
 * Left fold over tree elements.
 */
export function foldl<V, A, B>(
  tree: FingerTree<V, A>,
  f: (b: B, a: A) => B,
  z: B,
): B {
  const arr = toArray(tree);
  let acc = z;
  for (const x of arr) {
    acc = f(acc, x);
  }
  return acc;
}

/**
 * Lazy left-to-right iterator over tree elements.
 */
export function* iterate<V, A>(tree: FingerTree<V, A>): Generator<A> {
  yield* iterateTree(tree as FingerTree<unknown, unknown>, 0) as Generator<A>;
}

function* iterateTree(
  tree: FingerTree<unknown, unknown>,
  depth: number,
): Generator<unknown> {
  switch (tree.tag) {
    case "empty":
      return;
    case "single":
      yield* iterateElement(tree.a, depth);
      return;
    case "deep":
      yield* iterateDigit(tree.prefix, depth);
      yield* iterateTree(tree.middle, depth + 1);
      yield* iterateDigit(tree.suffix, depth);
  }
}

function* iterateElement(x: unknown, depth: number): Generator<unknown> {
  if (depth === 0) {
    yield x;
  } else {
    const node = x as Node<unknown, unknown>;
    for (const child of nodeToArray(node)) {
      yield* iterateElement(child, depth - 1);
    }
  }
}

function* iterateDigit(d: Digit<unknown>, depth: number): Generator<unknown> {
  for (const x of digitToArray(d)) {
    yield* iterateElement(x, depth);
  }
}
