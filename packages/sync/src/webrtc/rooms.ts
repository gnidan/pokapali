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
  /** Create the WebRTC room for a channel on demand.
   *  Idempotent — second call for the same namespace
   *  is a no-op. Ignored if no key exists for the
   *  namespace. */
  connectChannel(ns: string): void;
  destroy(): void;
}

export type SyncStatus = "connecting" | "connected" | "disconnected";

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

  const statusListeners: Array<(s: SyncStatus) => void> = [];
  const connectedChannels = new Set<string>();

  function notifyStatus() {
    const s = aggregateStatus(providers);
    for (const cb of statusListeners) cb(s);
  }

  function connectChannel(ns: string): void {
    if (connectedChannels.has(ns)) return;
    const key = keys[ns];
    if (!key) return;
    connectedChannels.add(ns);

    const roomName = `${ipnsName}:${ns}`;
    const password = bytesToHex(key);
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
    connectChannel,
    destroy() {
      statusListeners.length = 0;
      for (const p of providers) {
        p.off("status", notifyStatus);
        p.disconnect();
        p.destroy();
      }
      providers.length = 0;
      connectedChannels.clear();
    },
  };
}

export interface AwarenessRoom {
  readonly awareness: Awareness;
  readonly connected: boolean;
  onStatusChange(cb: () => void): void;
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

  function notifyStatus() {
    for (const cb of statusListeners) cb();
  }

  provider.on("status", notifyStatus);

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
    destroy() {
      statusListeners.length = 0;
      provider.off("status", notifyStatus);
      provider.disconnect();
      provider.destroy();
      dummyDoc.destroy();
    },
  };
}

function aggregateStatus(providers: WebrtcProvider[]): SyncStatus {
  if (providers.length === 0) {
    return "disconnected";
  }
  if (providers.some((p) => p.connected)) {
    return "connected";
  }
  if (providers.some((p) => p.shouldConnect)) {
    return "connecting";
  }
  return "disconnected";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
