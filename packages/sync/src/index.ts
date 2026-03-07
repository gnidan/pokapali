import type {
  SubdocManager
} from "@pokapali/subdocs";
import type { Awareness } from "y-protocols/awareness";

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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}
