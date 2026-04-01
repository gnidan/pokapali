import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
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

export function setupAwarenessRoom(
  ipnsName: string,
  awarenessPassword: string,
  signalingUrls: string[],
  options?: SyncOptions,
  /** Pre-created Awareness instance. Passed to the
   *  WebrtcProvider so the same awareness is shared
   *  with callers that need it before the room
   *  connects. */
  existingAwareness?: Awareness,
): AwarenessRoom {
  const dummyDoc = existingAwareness?.doc ?? new Y.Doc();
  const roomName = `${ipnsName}:awareness`;
  const provider = new WebrtcProvider(roomName, dummyDoc, {
    signaling: signalingUrls,
    password: awarenessPassword,
    ...(existingAwareness && {
      awareness: existingAwareness,
    }),
    ...(options?.peerOpts && {
      peerOpts: options.peerOpts,
    }),
  });

  const statusListeners: Array<() => void> = [];
  const peerConnListeners: Array<
    (pc: RTCPeerConnection, initiator: boolean) => void
  > = [];
  const notifiedPeers = new Set<string>();

  function notifyStatus() {
    for (const cb of statusListeners) cb();
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  function notifyPeer(peerId: string, conn: any): void {
    if (notifiedPeers.has(peerId)) return;
    const pc = conn?.peer?._pc as RTCPeerConnection | undefined;
    if (!pc) return;
    notifiedPeers.add(peerId);
    const initiator = !!conn.peer.initiator;
    console.debug(
      "[pokapali:rooms] peer ready",
      peerId.slice(0, 8),
      initiator ? "(initiator)" : "(responder)",
    );
    for (const cb of peerConnListeners) {
      cb(pc, initiator);
    }
  }

  function watchPeers(p: WebrtcProvider): void {
    p.on("peers", (change: { added: string[]; removed: string[] }) => {
      const room = (p as any).room;
      if (!room) {
        console.debug("[pokapali:rooms] peers event" + " but no room");
        return;
      }
      const conns = room.webrtcConns as Map<string, any>;
      console.debug(
        "[pokapali:rooms] peers event:" +
          ` +${change.added.length}` +
          ` -${change.removed.length}`,
        `total=${conns.size}`,
      );
      for (const peerId of change.added) {
        if (notifiedPeers.has(peerId)) continue;
        const conn = conns.get(peerId);
        if (!conn?.peer) {
          console.debug(
            "[pokapali:rooms] no conn" + " for peer",
            peerId.slice(0, 8),
          );
          continue;
        }

        // Try immediately — _pc may already
        // exist for fast (same-browser) conns.
        const pc = conn.peer._pc as RTCPeerConnection | undefined;
        if (pc) {
          notifyPeer(peerId, conn);
          continue;
        }

        // Cross-browser: _pc may not exist yet
        // because ICE negotiation is in progress.
        // Listen for simple-peer's "connect"
        // event which fires after the underlying
        // RTCPeerConnection is established.
        console.debug(
          "[pokapali:rooms] _pc not ready" + " for peer",
          peerId.slice(0, 8),
          "— waiting for connect event",
        );
        conn.peer.once("connect", () => {
          notifyPeer(peerId, conn);
        });
      }
      for (const peerId of change.removed) {
        notifiedPeers.delete(peerId);
      }
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  provider.on("status", notifyStatus);
  watchPeers(provider);

  return {
    get awareness(): Awareness {
      return provider.awareness;
    },
    get connected(): boolean {
      return provider.connected;
    },
    onStatusChange(cb: () => void) {
      statusListeners.push(cb);
    },
    onPeerCreated() {
      // y-webrtc doesn't expose pre-SDP hooks;
      // data channels must be added via
      // onPeerConnection instead.
      return () => {};
    },
    onPeerConnection(cb: (pc: RTCPeerConnection, initiator: boolean) => void) {
      peerConnListeners.push(cb);
      return () => {
        const idx = peerConnListeners.indexOf(cb);
        if (idx >= 0) {
          peerConnListeners.splice(idx, 1);
        }
      };
    },
    destroy() {
      statusListeners.length = 0;
      peerConnListeners.length = 0;
      notifiedPeers.clear();
      provider.off("status", notifyStatus);
      provider.disconnect();
      provider.destroy();
      dummyDoc.destroy();
    },
  };
}

// -------------------------------------------------------
// Signaling-based awareness room
// -------------------------------------------------------

export interface SignaledAwarenessOptions {
  rtcConfig?: RTCConfiguration;
}

/**
 * Set up an awareness room using the dedicated
 * signaling protocol instead of GossipSub.
 *
 * Uses SignalingClient for peer discovery and
 * SDP/ICE exchange. WebRTC connections are created
 * directly (no y-webrtc / simple-peer). Awareness
 * is synced over a dedicated data channel using
 * y-protocols/awareness.
 *
 * Returns the same AwarenessRoom interface as
 * setupAwarenessRoom so wireDataChannel in
 * create-doc.ts continues to work unchanged.
 */
export function setupSignaledAwarenessRoom(
  ipnsName: string,
  localPeerId: string,
  signalingClient: SignalingClient,
  awareness: Awareness,
  options?: SignaledAwarenessOptions,
): AwarenessRoom {
  const roomName = `${ipnsName}:awareness`;
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
