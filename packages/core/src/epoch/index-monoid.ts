/**
 * Re-export summary monoid from @pokapali/document
 * for backwards compatibility.
 */
export type { Summary as EpochIndex } from "@pokapali/document";
export {
  Sum,
  MinMax,
  SetUnion,
  summaryMonoid as epochIndexMonoid,
  epochMeasured,
} from "@pokapali/document";
