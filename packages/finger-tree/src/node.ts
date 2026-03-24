import type { Measured } from "./monoid.js";
import type { Node } from "./types.js";

export function node2<V, A>(m: Measured<V, A>, a: A, b: A): Node<V, A> {
  return {
    tag: "node2",
    v: m.monoid.append(m.measure(a), m.measure(b)),
    a,
    b,
  };
}

export function node3<V, A>(m: Measured<V, A>, a: A, b: A, c: A): Node<V, A> {
  return {
    tag: "node3",
    v: m.monoid.append(
      m.monoid.append(m.measure(a), m.measure(b)),
      m.measure(c),
    ),
    a,
    b,
    c,
  };
}

export function nodeToArray<V, A>(node: Node<V, A>): A[] {
  return node.tag === "node2" ? [node.a, node.b] : [node.a, node.b, node.c];
}

/**
 * Lift a Measured<V, A> to Measured<V, Node<V, A>>
 * by reading the cached annotation.
 */
export function nodeMeasured<V, A>(m: Measured<V, A>): Measured<V, Node<V, A>> {
  return {
    monoid: m.monoid,
    measure: (node) => node.v,
  };
}
