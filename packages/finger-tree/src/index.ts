// @pokapali/finger-tree
// Generic finger tree parameterized by a monoid.
// Hinze & Paterson, JFP 16:2 (2006).

// Types
export type { Monoid, Measured } from "./monoid.js";
export type { FingerTree, Node, Digit } from "./types.js";

// Monoid composition
export { combine } from "./monoid.js";

// Construction
export { empty, singleton } from "./tree.js";
export { fromArray } from "./fold.js";

// Access
export {
  cons,
  snoc,
  head,
  last,
  isEmpty,
  viewl,
  viewr,
  measureTree,
} from "./tree.js";

// Combination
export { concat } from "./concat.js";

// Splitting
export type { Split } from "./split.js";
export { split, takeUntil, dropUntil } from "./split.js";

// Folding & iteration
export { toArray, foldr, foldl, iterate } from "./fold.js";
