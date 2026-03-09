import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";
import type { SubdocManager } from "@pokapali/subdocs";
import {
  createGossipSubSignaling,
  type PubSubLike,
} from "./gossipsub-signaling.js";

export { createGossipSubSignaling } from
  "./gossipsub-signaling.js";
export type { PubSubLike } from
  "./gossipsub-signaling.js";

export interface SyncManager {
  readonly status: SyncStatus;
  onStatusChange(cb: (s: SyncStatus) => void): void;
  destroy(): void;
}

export type SyncStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export interface SyncOptions {
  peerOpts?: { config?: RTCConfiguration };
  pubsub?: PubSubLike;
}

export function setupNamespaceRooms(
  ipnsName: string,
  subdocManager: SubdocManager,
  keys: Record<string, Uint8Array>,
  signalingUrls: string[],
  options?: SyncOptions,
): SyncManager {
  const providers: WebrtcProvider[] = [];

  if (options?.pubsub) {
    createGossipSubSignaling(options.pubsub);
  }

  const signaling = options?.pubsub
    ? [...signalingUrls, "libp2p:gossipsub"]
    : signalingUrls;

  const statusListeners: Array<
    (s: SyncStatus) => void
  > = [];

  function notifyStatus() {
    const s = aggregateStatus(providers);
    for (const cb of statusListeners) cb(s);
  }

  for (const ns of Object.keys(keys)) {
    const roomName = `${ipnsName}:${ns}`;
    const password = bytesToHex(keys[ns]);
    const doc = subdocManager.subdoc(ns);
    const provider = new WebrtcProvider(roomName, doc, {
      signaling,
      password,
      ...(options?.peerOpts && {
        peerOpts: options.peerOpts,
      }),
    });
    provider.on("status", notifyStatus);
    providers.push(provider);
  }

  return {
    get status() {
      return aggregateStatus(providers);
    },
    onStatusChange(cb: (s: SyncStatus) => void) {
      statusListeners.push(cb);
    },
    destroy() {
      statusListeners.length = 0;
      for (const p of providers) {
        p.off("status", notifyStatus);
        p.disconnect();
        p.destroy();
      }
      providers.length = 0;
    },
  };
}

export interface AwarenessRoom {
  readonly awareness: Awareness;
  destroy(): void;
}

export function setupAwarenessRoom(
  ipnsName: string,
  awarenessPassword: string,
  signalingUrls: string[],
  options?: SyncOptions,
): AwarenessRoom {
  if (options?.pubsub) {
    createGossipSubSignaling(options.pubsub);
  }

  const signaling = options?.pubsub
    ? [...signalingUrls, "libp2p:gossipsub"]
    : signalingUrls;

  const dummyDoc = new Y.Doc();
  const roomName = `${ipnsName}:awareness`;
  const provider = new WebrtcProvider(roomName, dummyDoc, {
    signaling,
    password: awarenessPassword,
    ...(options?.peerOpts && {
      peerOpts: options.peerOpts,
    }),
  });

  return {
    get awareness(): Awareness {
      return provider.awareness;
    },
    destroy() {
      provider.disconnect();
      provider.destroy();
      dummyDoc.destroy();
    },
  };
}

function aggregateStatus(
  providers: WebrtcProvider[],
): SyncStatus {
  if (providers.length === 0) {
    return "disconnected";
  }
  let allConnected = true;
  let anyConnecting = false;
  for (const p of providers) {
    if (!p.connected) {
      allConnected = false;
      if (p.shouldConnect) {
        anyConnecting = true;
      }
    }
  }
  if (allConnected) return "connected";
  if (anyConnecting) return "connecting";
  return "disconnected";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
