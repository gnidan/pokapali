import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";
import type { SubdocManager } from "@pokapali/subdocs";

export interface SyncManager {
  readonly status:
    | "connecting"
    | "connected"
    | "disconnected";
  destroy(): void;
}

export function setupNamespaceRooms(
  ipnsName: string,
  subdocManager: SubdocManager,
  keys: Record<string, Uint8Array>,
  signalingUrls: string[]
): SyncManager {
  const providers: WebrtcProvider[] = [];

  for (const ns of Object.keys(keys)) {
    const roomName = `${ipnsName}:${ns}`;
    const password = bytesToHex(keys[ns]);
    const doc = subdocManager.subdoc(ns);
    const provider = new WebrtcProvider(
      roomName, doc, {
        signaling: signalingUrls,
        password,
      }
    );
    providers.push(provider);
  }

  return {
    get status() {
      return aggregateStatus(providers);
    },
    destroy() {
      for (const p of providers) {
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
  signalingUrls: string[]
): AwarenessRoom {
  const dummyDoc = new Y.Doc();
  const roomName = `${ipnsName}:awareness`;
  const provider = new WebrtcProvider(
    roomName, dummyDoc, {
      signaling: signalingUrls,
      password: awarenessPassword,
    }
  );

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
  providers: WebrtcProvider[]
): "connecting" | "connected" | "disconnected" {
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
  return Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
