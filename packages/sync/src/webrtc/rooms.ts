import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";
import type { SubdocManager } from "@pokapali/subdocs";
import {
  createGossipSubSignaling,
  type PubSubLike,
} from "./gossipsub-signaling.js";

export type { Awareness } from "y-protocols/awareness";
export type { SubdocManager } from "@pokapali/subdocs";

export interface SyncManager {
  readonly status: SyncStatus;
  onStatusChange(cb: (s: SyncStatus) => void): void;
  /** @deprecated No-op — reconciliation handles
   *  channel sync. Retained for API compatibility. */
  connectChannel(ns: string): void;
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
  _subdocManager: SubdocManager,
  _keys: Record<string, Uint8Array>,
  _signalingUrls: string[],
  _options?: SyncOptions,
): SyncManager {
  return {
    get status(): SyncStatus {
      return "disconnected";
    },
    onStatusChange() {},
    connectChannel() {},
    destroy() {},
  };
}

export interface AwarenessRoom {
  readonly awareness: Awareness;
  readonly connected: boolean;
  onStatusChange(cb: () => void): void;
  /** Register a callback that fires when a new
   *  RTCPeerConnection is created by y-webrtc.
   *  `initiator` is true if we initiated the
   *  connection (relevant for data channel
   *  creation). */
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
  if (options?.pubsub) {
    createGossipSubSignaling(options.pubsub);
  }

  const signaling = options?.pubsub
    ? [...signalingUrls, "libp2p:gossipsub"]
    : signalingUrls;

  const dummyDoc = existingAwareness?.doc ?? new Y.Doc();
  const roomName = `${ipnsName}:awareness`;
  const provider = new WebrtcProvider(roomName, dummyDoc, {
    signaling,
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
