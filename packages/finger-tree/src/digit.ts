import type { Measured } from "./monoid.js";
import type { Digit } from "./types.js";

export function one<A>(a: A): Digit<A> {
  return { tag: "one", a };
}

export function two<A>(a: A, b: A): Digit<A> {
  return { tag: "two", a, b };
}

export function three<A>(a: A, b: A, c: A): Digit<A> {
  return { tag: "three", a, b, c };
}

export function four<A>(a: A, b: A, c: A, d: A): Digit<A> {
  return { tag: "four", a, b, c, d };
}

export function digitToArray<A>(d: Digit<A>): A[] {
  switch (d.tag) {
    case "one":
      return [d.a];
    case "two":
      return [d.a, d.b];
    case "three":
      return [d.a, d.b, d.c];
    case "four":
      return [d.a, d.b, d.c, d.d];
  }
}

export function digitMeasure<V, A>(m: Measured<V, A>, d: Digit<A>): V {
  switch (d.tag) {
    case "one":
      return m.measure(d.a);
    case "two":
      return m.monoid.append(m.measure(d.a), m.measure(d.b));
    case "three":
      return m.monoid.append(
        m.monoid.append(m.measure(d.a), m.measure(d.b)),
        m.measure(d.c),
      );
    case "four":
      return m.monoid.append(
        m.monoid.append(
          m.monoid.append(m.measure(d.a), m.measure(d.b)),
          m.measure(d.c),
        ),
        m.measure(d.d),
      );
  }
}

export function consDigit<A>(a: A, d: Digit<A>): Digit<A> {
  switch (d.tag) {
    case "one":
      return two(a, d.a);
    case "two":
      return three(a, d.a, d.b);
    case "three":
      return four(a, d.a, d.b, d.c);
    case "four":
      throw new Error("Cannot cons onto a Four digit");
  }
}

export function snocDigit<A>(d: Digit<A>, a: A): Digit<A> {
  switch (d.tag) {
    case "one":
      return two(d.a, a);
    case "two":
      return three(d.a, d.b, a);
    case "three":
      return four(d.a, d.b, d.c, a);
    case "four":
      throw new Error("Cannot snoc onto a Four digit");
  }
}

export function digitHead<A>(d: Digit<A>): A {
  return d.a;
}

export function digitTail<A>(d: Digit<A>): Digit<A> {
  switch (d.tag) {
    case "one":
      throw new Error("Cannot tail a One digit");
    case "two":
      return one(d.b);
    case "three":
      return two(d.b, d.c);
    case "four":
      return three(d.b, d.c, d.d);
  }
}

export function digitLast<A>(d: Digit<A>): A {
  switch (d.tag) {
    case "one":
      return d.a;
    case "two":
      return d.b;
    case "three":
      return d.c;
    case "four":
      return d.d;
  }
}

export function digitInit<A>(d: Digit<A>): Digit<A> {
  switch (d.tag) {
    case "one":
      throw new Error("Cannot init a One digit");
    case "two":
      return one(d.a);
    case "three":
      return two(d.a, d.b);
    case "four":
      return three(d.a, d.b, d.c);
  }
}
