// Channel + Document
export { Channel } from "./channel/index.js";
export {
  Document,
  type DocumentIdentity,
  type DocumentCapability,
  type Level,
} from "./document/index.js";
export { inspect } from "./inspect.js";

// Capability + Credential
export { Capability } from "./capability/index.js";
export type { Credential } from "./credential.js";

// View system
export { View, Cache, Status, foldTree } from "./view.js";
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
  History,
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
  epochMeasured,
  fromEpochs,
  emptyTree,
  fromSnapshots,
  backfillEdits,
  splitEpochAtSnapshot,
  mergeEpochs,
  mergeAdjacentInTree,
} from "./history/index.js";
