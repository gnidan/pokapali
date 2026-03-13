/**
 * Yjs-level sync harness for testing multi-peer
 * scenarios. Synchronous — no timers, no flakiness.
 */

import * as Y from "yjs";

export interface TestPeer {
  readonly name: string;
  /** Get the Y.Doc for a named channel. */
  channel(name: string): Y.Doc;
}

export interface TestNetwork {
  /** Get or create a named peer. */
  peer(name: string): TestPeer;
  /** Disconnect two peers (edits stop syncing). */
  disconnect(a: string, b: string): void;
  /** Reconnect two peers (flushes pending state). */
  reconnect(a: string, b: string): void;
  /**
   * Partition the network into groups. Peers within
   * a group stay connected; peers across groups are
   * disconnected.
   */
  partition(...groups: string[][]): void;
  /** Heal all partitions — fully reconnect. */
  heal(): void;
  /**
   * Check that all connected peers have converged
   * (identical state vectors for each channel).
   */
  isConverged(): boolean;
  /** Clean up all docs and observers. */
  destroy(): void;
}

export interface TestNetworkOptions {
  /** Channel names each peer will have. */
  channels: string[];
}

// ── Implementation ───────────────────────────────

interface PeerState {
  name: string;
  docs: Map<string, Y.Doc>;
}

type LinkKey = string;

function linkKey(a: string, b: string): LinkKey {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function createTestNetwork(options: TestNetworkOptions): TestNetwork {
  const { channels } = options;
  const peers = new Map<string, PeerState>();
  const connected = new Set<LinkKey>();
  let destroyed = false;

  function assertAlive() {
    if (destroyed) {
      throw new Error("TestNetwork destroyed");
    }
  }

  function assertPeer(name: string): PeerState {
    const p = peers.get(name);
    if (!p) {
      throw new Error(`Unknown peer "${name}"`);
    }
    return p;
  }

  function createPeer(name: string): PeerState {
    const docs = new Map<string, Y.Doc>();
    for (const ch of channels) {
      docs.set(ch, new Y.Doc());
    }
    const state: PeerState = { name, docs };
    peers.set(name, state);

    // Connect to all existing peers.
    for (const other of peers.values()) {
      if (other.name === name) continue;
      connect(name, other.name);
    }

    return state;
  }

  /** Sync one direction: from → to. */
  function syncOne(from: PeerState, to: PeerState) {
    for (const ch of channels) {
      const fromDoc = from.docs.get(ch)!;
      const toDoc = to.docs.get(ch)!;
      const sv = Y.encodeStateVector(toDoc);
      const update = Y.encodeStateAsUpdate(fromDoc, sv);
      Y.applyUpdate(toDoc, update);
    }
  }

  /** Bidirectional sync between two peers. */
  function syncPair(a: PeerState, b: PeerState) {
    syncOne(a, b);
    syncOne(b, a);
  }

  /** Set up live sync observers between two peers. */
  function connect(aName: string, bName: string) {
    const key = linkKey(aName, bName);
    if (connected.has(key)) return;
    connected.add(key);

    const a = peers.get(aName)!;
    const b = peers.get(bName)!;

    // Initial sync.
    syncPair(a, b);

    // Live sync via update observers.
    for (const ch of channels) {
      const aDoc = a.docs.get(ch)!;
      const bDoc = b.docs.get(ch)!;

      aDoc.on("update", function handler(update: Uint8Array, origin: unknown) {
        if (origin === bName) return;
        if (!connected.has(key)) return;
        Y.applyUpdate(bDoc, update, aName);
      });

      bDoc.on("update", function handler(update: Uint8Array, origin: unknown) {
        if (origin === aName) return;
        if (!connected.has(key)) return;
        Y.applyUpdate(aDoc, update, bName);
      });
    }
  }

  function disconnectPair(aName: string, bName: string) {
    connected.delete(linkKey(aName, bName));
  }

  function reconnectPair(aName: string, bName: string) {
    const key = linkKey(aName, bName);
    if (connected.has(key)) return;
    connected.add(key);

    // Flush pending state.
    const a = assertPeer(aName);
    const b = assertPeer(bName);
    syncPair(a, b);
  }

  return {
    peer(name) {
      assertAlive();
      let state = peers.get(name);
      if (!state) {
        state = createPeer(name);
      }
      return {
        name,
        channel(ch) {
          const doc = state!.docs.get(ch);
          if (!doc) {
            throw new Error(
              `Unknown channel "${ch}". ` + `Available: ${channels.join(", ")}`,
            );
          }
          return doc;
        },
      };
    },

    disconnect(a, b) {
      assertAlive();
      assertPeer(a);
      assertPeer(b);
      disconnectPair(a, b);
    },

    reconnect(a, b) {
      assertAlive();
      assertPeer(a);
      assertPeer(b);
      reconnectPair(a, b);
    },

    partition(...groups) {
      assertAlive();
      // Disconnect all cross-group links.
      const peerNames = [...peers.keys()];
      for (let i = 0; i < peerNames.length; i++) {
        for (let j = i + 1; j < peerNames.length; j++) {
          const a = peerNames[i];
          const b = peerNames[j];
          const aGroup = groups.findIndex((g) => g.includes(a));
          const bGroup = groups.findIndex((g) => g.includes(b));
          if (aGroup !== bGroup) {
            disconnectPair(a, b);
          }
        }
      }
    },

    heal() {
      assertAlive();
      const peerNames = [...peers.keys()];
      for (let i = 0; i < peerNames.length; i++) {
        for (let j = i + 1; j < peerNames.length; j++) {
          reconnectPair(peerNames[i], peerNames[j]);
        }
      }
    },

    isConverged() {
      assertAlive();
      const peerList = [...peers.values()];
      if (peerList.length < 2) return true;

      for (const ch of channels) {
        const first = peerList[0].docs.get(ch)!;
        const firstSv = Y.encodeStateVector(first);
        for (let i = 1; i < peerList.length; i++) {
          const other = peerList[i].docs.get(ch)!;
          const otherSv = Y.encodeStateVector(other);
          if (!uint8Equal(firstSv, otherSv)) {
            return false;
          }
        }
      }
      return true;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const state of peers.values()) {
        for (const doc of state.docs.values()) {
          doc.destroy();
        }
      }
      peers.clear();
      connected.clear();
    },
  };
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
