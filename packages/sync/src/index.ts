export {
  type PubSubLike,
  createThrottledInterval,
  type ThrottledInterval,
  type ThrottledIntervalOptions,
  setupNamespaceRooms,
  setupAwarenessRoom,
  setupSignaledAwarenessRoom,
  type SyncManager,
  type SyncStatus,
  type SyncOptions,
  type AwarenessRoom,
  type SignaledAwarenessOptions,
  type Awareness,
  type SubdocManager,
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
