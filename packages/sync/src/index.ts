import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { Awareness } from "y-protocols/awareness";
import { deriveMetaRoomPassword } from "@pokapali/crypto";
import type { SubdocManager } from "@pokapali/subdocs";

export type SyncStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export interface SyncManager {
  readonly status: SyncStatus;
  destroy(): void;
}

export interface NamespaceRoomsOptions {
  primaryNamespace?: string;
}

/**
 * Creates a WebrtcProvider per writable namespace plus
 * the _meta room. Room names are `${ipnsName}:${ns}`.
 * Passwords are hex-encoded namespace access key bytes.
 * The _meta room password is derived via
 * deriveMetaRoomPassword(primaryAccessKey).
 */
export async function setupNamespaceRooms(
  ipnsName: string,
  subdocManager: SubdocManager,
  keys: Record<string, Uint8Array>,
  signalingUrls: string[],
  options?: NamespaceRoomsOptions
): Promise<SyncManager> {
  const namespaces = Object.keys(keys);
  if (namespaces.length === 0) {
    return {
      get status() { return "disconnected" as const; },
      destroy() {},
    };
  }

  const primaryNs =
    options?.primaryNamespace ?? namespaces[0];
  const primaryKey = keys[primaryNs];
  if (!primaryKey) {
    throw new Error(
      `Primary namespace "${primaryNs}" not found`
      + " in keys"
    );
  }

  const providers: WebrtcProvider[] = [];

  // One provider per writable namespace
  for (const ns of namespaces) {
    const roomName = `${ipnsName}:${ns}`;
    const password = bytesToHex(keys[ns]);
    const doc = subdocManager.subdoc(ns);
    const provider = new WebrtcProvider(roomName, doc, {
      signaling: signalingUrls,
      password,
    });
    providers.push(provider);
  }

  // _meta room: password derived from primary key
  const metaPassword =
    await deriveMetaRoomPassword(primaryKey);
  const metaRoom = `${ipnsName}:_meta`;
  const metaProvider = new WebrtcProvider(
    metaRoom,
    subdocManager.metaDoc,
    {
      signaling: signalingUrls,
      password: metaPassword,
    }
  );
  providers.push(metaProvider);

  return {
    get status(): SyncStatus {
      return aggregateStatus(providers);
    },
    destroy() {
      for (const p of providers) {
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

/**
 * Creates a shared awareness room on a dummy Y.Doc.
 * All peers join regardless of capability level.
 * Password is the hex-encoded awarenessRoomPassword.
 */
export function setupAwarenessRoom(
  ipnsName: string,
  awarenessPassword: string,
  signalingUrls: string[]
): AwarenessRoom {
  const dummyDoc = new Y.Doc();
  const roomName = `${ipnsName}:awareness`;
  const provider = new WebrtcProvider(
    roomName,
    dummyDoc,
    {
      signaling: signalingUrls,
      password: awarenessPassword,
    }
  );

  return {
    get awareness(): Awareness {
      return provider.awareness;
    },
    destroy() {
      provider.destroy();
      dummyDoc.destroy();
    },
  };
}

function aggregateStatus(
  providers: WebrtcProvider[]
): SyncStatus {
  if (providers.length === 0) {
    return "disconnected";
  }
  let anyConnected = false;
  let anyConnecting = false;
  for (const p of providers) {
    if (p.connected) {
      anyConnected = true;
    } else if (p.shouldConnect) {
      anyConnecting = true;
    }
  }
  if (anyConnected) return "connected";
  if (anyConnecting) return "connecting";
  return "disconnected";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
