/**
 * A monoid: an associative binary operation with an
 * identity element.
 */
export interface Monoid<V> {
  readonly empty: V;
  readonly append: (a: V, b: V) => V;
}

/**
 * Measured: elements of type A can be projected into
 * a monoid V.
 *
 * The monoid V defines how measures combine.
 * The measure function projects a single element.
 */
export interface Measured<V, A> {
  readonly monoid: Monoid<V>;
  readonly measure: (a: A) => V;
}

/**
 * Assemble a product monoid from component monoids.
 *
 * Given an object mapping keys to monoids, returns a
 * monoid over objects with those same keys. Empty has
 * each component's empty. Append merges key-wise.
 */
export function combine<T extends object>(monoids: {
  [K in keyof T]: Monoid<T[K]>;
}): Monoid<T> {
  const keys = Object.keys(monoids) as (keyof T)[];
  return {
    empty: Object.fromEntries(keys.map((k) => [k, monoids[k].empty])) as T,
    append: (a, b) =>
      Object.fromEntries(
        keys.map((k) => [k, monoids[k].append(a[k], b[k])]),
      ) as T,
  };
}
