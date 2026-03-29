export {
  createGossipSubSignaling,
  GossipSubSignaling,
  type PubSubLike,
  createThrottledInterval,
  type ThrottledInterval,
  type ThrottledIntervalOptions,
  setupNamespaceRooms,
  setupAwarenessRoom,
  type SyncManager,
  type SyncStatus,
  type SyncOptions,
  type AwarenessRoom,
  type Awareness,
  type SubdocManager,
} from "./webrtc/index.js";

export { Edits } from "./edits.js";
export { Convergence } from "./convergence.js";
export * as Hydration from "./hydration/index.js";

// Reconciliation
export {
  createCoordinator,
  type ReconciliationCoordinator,
  type EditApplier,
  type MessageSender,
  type CoordinatorOptions,
} from "./reconciliation/coordinator.js";
export {
  createTransport,
  createReconcileChannel,
  type ReconciliationTransport,
} from "./reconciliation/transport.js";
export {
  collectEditHashes,
  channelFingerprint,
} from "./reconciliation/edit-resolver.js";
export { type Message as ReconciliationMessage } from "./reconciliation/messages.js";
