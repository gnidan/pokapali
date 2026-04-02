import type { Awareness } from "y-protocols/awareness";
import { createLogger } from "@pokapali/log";
import type { SignalingClient } from "../signaling/client.js";
import { createPeerManager } from "../signaling/peer-connection.js";
import { syncAwareness } from "../signaling/awareness-sync.js";

const diagLog = createLogger("p2p-diag");

export type { Awareness } from "y-protocols/awareness";
/**
 * Minimal PubSub interface compatible with libp2p's
 * GossipSub. Used by core for announce, node-registry,
 * and discovery — not for signaling.
 */
export interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  addEventListener(type: string, handler: (evt: CustomEvent) => void): void;
  removeEventListener(type: string, handler: (evt: CustomEvent) => void): void;
}

export interface SyncManager {
  readonly status: SyncStatus;
  onStatusChange(cb: (s: SyncStatus) => void): void;
  destroy(): void;
}

export type SyncStatus = "connecting" | "connected" | "disconnected";

export interface SyncOptions {
  peerOpts?: { config?: RTCConfiguration };
  pubsub?: PubSubLike;
}

/**
 * Returns a thin SyncManager shell. Per-channel
 * WebrtcProviders have been removed — reconciliation
 * handles all document data sync. This function is
 * retained so callers that depend on the SyncManager
 * interface continue to work.
 */
export function setupNamespaceRooms(
  _ipnsName: string,
  _keys: Record<string, Uint8Array>,
  _signalingUrls: string[],
  _options?: SyncOptions,
): SyncManager {
  return {
    get status(): SyncStatus {
      return "disconnected";
    },
    onStatusChange() {},
    destroy() {},
  };
}

export interface AwarenessRoom {
  readonly awareness: Awareness;
  readonly connected: boolean;
  onStatusChange(cb: () => void): void;
  /** Fires when a new RTCPeerConnection is created
   *  but BEFORE the SDP offer. Use this to add data
   *  channels so they're included in negotiation. */
  onPeerCreated(
    cb: (pc: RTCPeerConnection, initiator: boolean) => void,
  ): () => void;
  /** Fires when an RTCPeerConnection reaches
   *  "connected" state. */
  onPeerConnection(
    cb: (pc: RTCPeerConnection, initiator: boolean) => void,
  ): () => void;
  destroy(): void;
}

export interface SignaledAwarenessOptions {
  rtcConfig?: RTCConfiguration;
  networkId?: string;
}

/**
 * Set up an awareness room using the dedicated
 * signaling protocol.
 *
 * Uses SignalingClient for peer discovery and
 * SDP/ICE exchange. WebRTC connections are created
 * directly. Awareness is synced over a dedicated
 * data channel using y-protocols/awareness.
 */
export function setupSignaledAwarenessRoom(
  ipnsName: string,
  localPeerId: string,
  signalingClient: SignalingClient,
  awareness: Awareness,
  options?: SignaledAwarenessOptions,
): AwarenessRoom {
  const nid = options?.networkId ?? "main";
  const roomName = `${nid}.${ipnsName}:awareness`;
  let connected = false;
  const statusListeners: Array<() => void> = [];
  const cleanups: Array<() => void> = [];

  const peerManager = createPeerManager(
    signalingClient,
    roomName,
    localPeerId,
    { rtcConfig: options?.rtcConfig },
  );

  // Add data channels BEFORE the SDP offer so ICE
  // negotiation has something to work with. The
  // initiator creates the awareness DC; both sides
  // listen for incoming DCs.
  const unsubCreated = peerManager.onPeerCreated((pc, initiator) => {
    if (initiator) {
      const dc = pc.createDataChannel("pokapali-awareness");
      dc.binaryType = "arraybuffer";
      const cleanup = syncAwareness(awareness, dc);
      cleanups.push(cleanup);
      dc.addEventListener("close", cleanup);
    }

    // Responder receives the awareness DC
    pc.addEventListener("datachannel", (evt: RTCDataChannelEvent) => {
      if (evt.channel.label === "pokapali-awareness") {
        evt.channel.binaryType = "arraybuffer";
        const cleanup = syncAwareness(awareness, evt.channel);
        cleanups.push(cleanup);
        evt.channel.addEventListener("close", cleanup);
      }
    });
  });

  // Track connection status
  const unsubPC = peerManager.onPeerConnection(() => {
    if (!connected) {
      connected = true;
      for (const cb of statusListeners) cb();
    }
  });

  // Join the signaling room
  diagLog.debug("setupSignaledAwarenessRoom: joining", roomName);
  signalingClient.joinRoom(roomName);

  return {
    get awareness(): Awareness {
      return awareness;
    },
    get connected(): boolean {
      return connected;
    },
    onStatusChange(cb: () => void) {
      statusListeners.push(cb);
    },
    onPeerCreated(cb: (pc: RTCPeerConnection, initiator: boolean) => void) {
      return peerManager.onPeerCreated(cb);
    },
    onPeerConnection(cb: (pc: RTCPeerConnection, initiator: boolean) => void) {
      return peerManager.onPeerConnection(cb);
    },
    destroy() {
      signalingClient.leaveRoom(roomName);
      unsubCreated();
      unsubPC();
      peerManager.destroy();
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      statusListeners.length = 0;
    },
  };
}
