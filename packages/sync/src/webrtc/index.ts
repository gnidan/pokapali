export {
  createThrottledInterval,
  type ThrottledInterval,
  type ThrottledIntervalOptions,
} from "./throttled-interval.js";

export {
  setupNamespaceRooms,
  setupAwarenessRoom,
  setupSignaledAwarenessRoom,
  type SyncManager,
  type SyncStatus,
  type SyncOptions,
  type AwarenessRoom,
  type SignaledAwarenessOptions,
  type PubSubLike,
} from "./rooms.js";

export type { Awareness } from "y-protocols/awareness";
