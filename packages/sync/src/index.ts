export {
  type PubSubLike,
  createThrottledInterval,
  type ThrottledInterval,
  type ThrottledIntervalOptions,
  setupNamespaceRooms,
  setupSignaledAwarenessRoom,
  type SyncManager,
  type SyncStatus,
  type SyncOptions,
  type AwarenessRoom,
  type SignaledAwarenessOptions,
  createMultiRelayRoom,
  type MultiRelayRoom,
  type Awareness,
} from "./webrtc/index.js";

// Signaling
export {
  createSignalingClient,
  type SignalingClient,
  type SignalingStream,
} from "./signaling/client.js";
export {
  SIGNALING_PROTOCOL,
  SignalType,
  type SignalMessage,
} from "./signaling/protocol.js";

export { Edits } from "./edits.js";
export { Convergence } from "./convergence.js";
export { SNAPSHOT_ORIGIN, type SubdocProvider } from "./subdoc-provider.js";
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
  type SnapshotMessage,
} from "./reconciliation/transport.js";
export {
  createSnapshotExchange,
  type SnapshotExchange,
  type SnapshotExchangeOptions,
  type SnapshotCatalogEntry,
} from "./reconciliation/snapshot-exchange.js";
export {
  collectEditHashes,
  channelFingerprint,
} from "./reconciliation/edit-resolver.js";
export {
  MessageType as ReconciliationMessageType,
  type Message as ReconciliationMessage,
} from "./reconciliation/messages.js";
