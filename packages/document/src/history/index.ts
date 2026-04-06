// Primary exports — companion object pattern
export { Edit } from "./edit.js";
export type { Origin, EditOrigin } from "./edit.js";

export { Epoch, Boundary } from "./epoch.js";
export type { EpochBoundary } from "./epoch.js";

export { Summary } from "./summary.js";

export { History } from "./history.js";

export type { Snapshot } from "./builders.js";

// -------------------------------------------------
// Deprecated re-exports for backwards compatibility
// -------------------------------------------------

export {
  edit,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
  epoch,
  appendEdit,
  isOpen,
  closeEpoch,
  snapshotEpoch,
} from "./types.js";

export {
  Sum,
  MinMax,
  SetUnion,
  summaryMonoid,
  epochMeasured,
} from "./summary.js";

export { fromEpochs, emptyTree } from "./history.js";

export { fromSnapshots, backfillEdits } from "./builders.js";

export { splitEpochAtSnapshot } from "./split.js";

export { mergeEpochs, mergeAdjacentInTree } from "./merge.js";
