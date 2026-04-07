/**
 * In-memory room registry for the signaling relay.
 *
 * Tracks which peers are in which rooms and provides
 * the stream handle for each peer so the handler can
 * forward signals.
 *
 * @module
 */

export interface PeerEntry {
  peerId: string;
  send: (bytes: Uint8Array) => void;
}

export interface RoomRegistry {
  join(room: string, entry: PeerEntry): void;
  leave(room: string, peerId: string): void;
  leaveAll(peerId: string, send?: (bytes: Uint8Array) => void): string[];
  members(room: string): PeerEntry[];
  findPeer(room: string, peerId: string): PeerEntry | undefined;
}

export function createRoomRegistry(): RoomRegistry {
  const rooms = new Map<string, Map<string, PeerEntry>>();

  function ensureRoom(room: string): Map<string, PeerEntry> {
    let r = rooms.get(room);
    if (!r) {
      r = new Map();
      rooms.set(room, r);
    }
    return r;
  }

  return {
    join(room: string, entry: PeerEntry): void {
      ensureRoom(room).set(entry.peerId, entry);
    },

    leave(room: string, peerId: string): void {
      const r = rooms.get(room);
      if (!r) return;
      r.delete(peerId);
      if (r.size === 0) rooms.delete(room);
    },

    leaveAll(peerId: string, send?: (bytes: Uint8Array) => void): string[] {
      const leftRooms: string[] = [];
      for (const [room, members] of rooms) {
        const entry = members.get(peerId);
        if (!entry) continue;
        // If a send reference is provided, only
        // remove the entry if it matches. This
        // prevents an old stream's cleanup from
        // removing a newer stream's registration.
        if (send && entry.send !== send) continue;
        members.delete(peerId);
        leftRooms.push(room);
        if (members.size === 0) rooms.delete(room);
      }
      return leftRooms;
    },

    members(room: string): PeerEntry[] {
      const r = rooms.get(room);
      if (!r) return [];
      return Array.from(r.values());
    },

    findPeer(room: string, peerId: string): PeerEntry | undefined {
      return rooms.get(room)?.get(peerId);
    },
  };
}
