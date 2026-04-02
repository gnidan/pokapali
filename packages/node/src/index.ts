export type {
  PinnerConfig,
  Pinner,
  PinnerMetrics,
  TipData,
  GuaranteeData,
} from "./pinner.js";

export { createPinner } from "./pinner.js";

export type {
  RelayConfig,
  Relay,
  NodeCapabilities,
  NodeNeighbor,
} from "./relay.js";
export {
  startRelay,
  encodeNodeCaps,
  decodeNodeCaps,
  NODE_CAPS_TOPIC,
  nodeCapsTopic,
} from "./relay.js";
export { announceTopic } from "@pokapali/core/announce";

// Signaling handler (for test relays and custom nodes)
export { SIGNALING_PROTOCOL } from "./signaling/protocol.js";
export { createRoomRegistry } from "./signaling/registry.js";
export type { RoomRegistry } from "./signaling/registry.js";
export { handleSignalingStream } from "./signaling/handler.js";
export type { SignalingStream as RelaySignalingStream } from "./signaling/handler.js";
export {
  createRelayForwarder,
  RELAY_SIGNALING_TOPIC,
  relaySignalingTopic,
} from "./signaling/relay-forward.js";
export type { RelayForwarder } from "./signaling/relay-forward.js";

export type {
  HttpConfig,
  HttpsConfig,
  TipResponse,
  GuaranteeResponse,
} from "./http.js";
export { startHttpServer, startBlockServer } from "./http.js";

/** @internal */
export type { RateLimiterConfig, RateLimiter } from "./rate-limiter.js";
/** @internal */
export { createRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";

/** @internal */
export type {
  SnapshotRecord,
  HistoryEntry,
  HistoryTracker,
} from "./history.js";
/** @internal */
export { createHistoryTracker } from "./history.js";
