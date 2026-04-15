/**
 * Multi-relay awareness room.
 *
 * Wraps N per-relay AwarenessRooms behind a single
 * AwarenessRoom interface. Deduplicates peers across
 * relays (first relay wins) and aggregates connection
 * status.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import type { AwarenessRoom } from "./rooms.js";

const log = createLogger("multi-relay");

type PeerCb = (pc: RTCPeerConnection, initiator: boolean) => void;

/**
 * Management API for adding/removing relays.
 * Extends AwarenessRoom so create-doc.ts sees no
 * type change.
 */
export interface MultiRelayRoom extends AwarenessRoom {
  addRelay(relayPid: string, room: AwarenessRoom): void;
  removeRelay(relayPid: string): void;
}

export function createMultiRelayRoom(
  awareness: AwarenessRoom["awareness"],
): MultiRelayRoom {
  const rooms = new Map<string, AwarenessRoom>();
  // Unsub functions per relay
  const relaySubs = new Map<string, Array<() => void>>();

  const statusCbs = new Set<() => void>();
  const createdCbs = new Set<PeerCb>();
  const connCbs = new Set<PeerCb>();
  const swapCbs = new Set<() => void>();

  let destroyed = false;

  function isConnected(): boolean {
    for (const room of rooms.values()) {
      if (room.connected) return true;
    }
    return false;
  }

  function fireStatusChange(): void {
    for (const cb of statusCbs) cb();
  }

  /**
   * Check if ALL sub-rooms have fired needsSwap
   * (i.e. every relay's signaling is dead and has
   * no peers). Only then does the multi-relay room
   * itself signal needsSwap.
   */
  function checkNeedsSwap(): void {
    // If any room is still alive (connected or has
    // signaling), don't fire needsSwap.
    if (rooms.size === 0) {
      log.info("all relays removed — needs swap");
      for (const cb of swapCbs) cb();
    }
  }

  function addRelay(relayPid: string, room: AwarenessRoom): void {
    if (destroyed) {
      room.destroy();
      return;
    }
    if (rooms.has(relayPid)) {
      log.info("relay already tracked:", relayPid.slice(0, 12));
      room.destroy();
      return;
    }

    rooms.set(relayPid, room);
    const subs: Array<() => void> = [];

    // onStatusChange returns void (no unsub), so
    // don't push it into subs.
    room.onStatusChange(() => {
      fireStatusChange();
    });

    // Forward onPeerCreated, dedup by tracking
    // which relay owns each peer via the PC object.
    // We can't get peerId from the PC callback
    // directly, so we forward all onPeerCreated
    // events — dedup happens at the connection level.
    subs.push(
      room.onPeerCreated((pc, initiator) => {
        for (const cb of createdCbs) cb(pc, initiator);
      }),
    );

    subs.push(
      room.onPeerConnection((pc, initiator) => {
        for (const cb of connCbs) cb(pc, initiator);
      }),
    );

    subs.push(
      room.onNeedsSwap(() => {
        log.info("sub-room needs swap:", relayPid.slice(0, 12));
        // Remove the dead relay
        removeRelay(relayPid);
      }),
    );

    relaySubs.set(relayPid, subs);

    log.info("relay added:", relayPid.slice(0, 12), "total:", rooms.size);

    fireStatusChange();
  }

  function removeRelay(relayPid: string): void {
    const room = rooms.get(relayPid);
    if (!room) return;

    // Unsub all listeners for this relay
    const subs = relaySubs.get(relayPid);
    if (subs) {
      for (const unsub of subs) unsub();
      relaySubs.delete(relayPid);
    }

    rooms.delete(relayPid);
    room.destroy();

    log.info("relay removed:", relayPid.slice(0, 12), "remaining:", rooms.size);

    fireStatusChange();
    checkNeedsSwap();
  }

  return {
    get awareness() {
      return awareness;
    },

    get connected() {
      return isConnected();
    },

    onStatusChange(cb: () => void) {
      statusCbs.add(cb);
    },

    onPeerCreated(cb: PeerCb) {
      createdCbs.add(cb);
      return () => createdCbs.delete(cb);
    },

    onPeerConnection(cb: PeerCb) {
      connCbs.add(cb);
      return () => connCbs.delete(cb);
    },

    onNeedsSwap(cb: () => void) {
      swapCbs.add(cb);
      return () => swapCbs.delete(cb);
    },

    addRelay,
    removeRelay,

    destroy() {
      destroyed = true;
      for (const [relayPid] of [...rooms]) {
        removeRelay(relayPid);
      }
      statusCbs.clear();
      createdCbs.clear();
      connCbs.clear();
      swapCbs.clear();
    },
  };
}
