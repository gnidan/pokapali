/**
 * Internal 2-3 tree node with cached monoidal
 * measure.
 */
export type Node<V, A> =
  | {
      readonly tag: "node2";
      readonly v: V;
      readonly a: A;
      readonly b: A;
    }
  | {
      readonly tag: "node3";
      readonly v: V;
      readonly a: A;
      readonly b: A;
      readonly c: A;
    };

/**
 * Digit: 1-4 elements at the tree's edges.
 */
export type Digit<A> =
  | { readonly tag: "one"; readonly a: A }
  | { readonly tag: "two"; readonly a: A; readonly b: A }
  | {
      readonly tag: "three";
      readonly a: A;
      readonly b: A;
      readonly c: A;
    }
  | {
      readonly tag: "four";
      readonly a: A;
      readonly b: A;
      readonly c: A;
      readonly d: A;
    };

/**
 * FingerTree: persistent sequence with monoidal
 * annotations.
 *
 * The `middle` field in Deep holds a
 * FingerTree<V, Node<V, A>> but is typed as
 * FingerTree<V, unknown> to handle TypeScript's
 * inability to express non-regular recursive types.
 * Internal code casts safely; the public API is
 * fully typed.
 */
export type FingerTree<V, A> =
  | { readonly tag: "empty" }
  | { readonly tag: "single"; readonly a: A }
  | {
      readonly tag: "deep";
      readonly v: V;
      readonly prefix: Digit<A>;
      readonly middle: FingerTree<V, unknown>;
      readonly suffix: Digit<A>;
    };
