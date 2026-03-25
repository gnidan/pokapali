// View system
export { View, Cache, Status, inspect } from "./view.js";
export { Feed } from "./feed/index.js";
export { Registry } from "./registry/index.js";
export * as State from "./state/index.js";
export * as Fingerprint from "./fingerprint/index.js";
export { diff } from "./diff.js";

// History module
export {
  Edit,
  type Origin,
  type EditOrigin,
  Epoch,
  Boundary,
  type EpochBoundary,
  Summary,
  type EpochIndex,
  History,
  type EpochTree,
  type Snapshot,
  // Deprecated backwards-compat re-exports
  edit,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
  epoch,
  appendEdit,
  isOpen,
  closeEpoch,
  snapshotEpoch,
  Sum,
  MinMax,
  SetUnion,
  summaryMonoid,
  epochIndexMonoid,
  epochMeasured,
  fromEpochs,
  emptyTree,
  fromSnapshots,
  backfillEdits,
  splitEpochAtSnapshot,
  mergeEpochs,
  mergeAdjacentInTree,
} from "./history/index.js";
