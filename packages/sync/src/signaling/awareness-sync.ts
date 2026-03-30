/**
 * Awareness sync over an RTCDataChannel.
 *
 * Sends/receives y-protocols/awareness updates as
 * raw Uint8Array messages over a WebRTC data channel.
 *
 * @module
 */

import {
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { Awareness } from "y-protocols/awareness";

/**
 * Sync an Awareness instance over an RTCDataChannel.
 * Sends a full state snapshot on connect, then
 * incrementally forwards local awareness changes.
 *
 * Returns a cleanup function that removes all
 * listeners.
 */
export function syncAwareness(
  awareness: Awareness,
  dc: RTCDataChannel,
): () => void {
  // Track remote client IDs received through this
  // channel so we can remove them on disconnect.
  const remoteClients = new Set<number>();

  function sendFullState(): void {
    const clients = Array.from(awareness.getStates().keys());
    if (clients.length === 0) return;
    const update = encodeAwarenessUpdate(awareness, clients);
    dc.send(update as unknown as ArrayBuffer);
  }

  function onAwarenessUpdate(
    {
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    },
    origin: unknown,
  ): void {
    // Don't echo back updates received from this
    // data channel.
    if (origin === dc) return;
    const changed = added.concat(updated, removed);
    if (changed.length === 0) return;
    if (dc.readyState !== "open") return;
    const update = encodeAwarenessUpdate(awareness, changed);
    dc.send(update as unknown as ArrayBuffer);
  }

  function onMessage(evt: MessageEvent): void {
    const data = evt.data;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : null;
    if (!bytes) return;

    // Track which clients came from this peer
    // before applying (so we know what to clean up)
    const before = new Set(awareness.getStates().keys());
    applyAwarenessUpdate(awareness, bytes, dc);
    for (const id of awareness.getStates().keys()) {
      if (!before.has(id) && id !== awareness.clientID) {
        remoteClients.add(id);
      }
    }
  }

  function onOpen(): void {
    sendFullState();
  }

  // Register listeners
  awareness.on("update", onAwarenessUpdate);
  dc.addEventListener("message", onMessage);

  if (dc.readyState === "open") {
    sendFullState();
  } else {
    dc.addEventListener("open", onOpen);
  }

  return () => {
    awareness.off("update", onAwarenessUpdate);
    dc.removeEventListener("message", onMessage);
    dc.removeEventListener("open", onOpen);
    // Remove remote peer's awareness states
    if (remoteClients.size > 0) {
      removeAwarenessStates(
        awareness,
        Array.from(remoteClients),
        "peer-disconnect",
      );
    }
  };
}
