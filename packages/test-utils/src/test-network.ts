/**
 * Yjs-level sync harness for testing multi-peer
 * scenarios. Synchronous by default — no timers,
 * no flakiness. Optionally adds configurable
 * latency simulation for realistic delay testing.
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
  /**
   * Wait for all pending delayed updates to be
   * delivered. Resolves immediately when no latency
   * is configured or no updates are in flight.
   */
  settle(): Promise<void>;
  /** Clean up all docs and observers. */
  destroy(): void;
}

export interface LatencyOptions {
  /** Base delay in milliseconds. */
  ms: number;
  /**
   * Random jitter range in milliseconds.
   * Actual delay = ms + random(-jitter, +jitter).
   * Clamped to >= 0.
   */
  jitter?: number;
}

export interface TestNetworkOptions {
  /** Channel names each peer will have. */
  channels: string[];
  /** Optional latency simulation. */
  latency?: LatencyOptions;
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

function computeDelay(lat: LatencyOptions): number {
  const jitter = lat.jitter ?? 0;
  const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
  return Math.max(0, lat.ms + offset);
}

export function createTestNetwork(options: TestNetworkOptions): TestNetwork {
  const { channels, latency } = options;
  const peers = new Map<string, PeerState>();
  const connected = new Set<LinkKey>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
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

  /**
   * Apply an update, either immediately or after
   * a latency delay.
   */
  function deliverUpdate(
    target: Y.Doc,
    update: Uint8Array,
    origin: string,
    key: LinkKey,
  ) {
    if (!latency) {
      if (!connected.has(key)) return;
      Y.applyUpdate(target, update, origin);
      return;
    }

    const delay = computeDelay(latency);
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (destroyed) return;
      if (!connected.has(key)) return;
      Y.applyUpdate(target, update, origin);
    }, delay);
    pendingTimers.add(timer);
  }

  /** Set up live sync observers between two peers. */
  function connect(aName: string, bName: string) {
    const key = linkKey(aName, bName);
    if (connected.has(key)) return;
    connected.add(key);

    const a = peers.get(aName)!;
    const b = peers.get(bName)!;

    // Initial sync is always immediate.
    syncPair(a, b);

    // Live sync via update observers.
    for (const ch of channels) {
      const aDoc = a.docs.get(ch)!;
      const bDoc = b.docs.get(ch)!;

      aDoc.on("update", function handler(update: Uint8Array, origin: unknown) {
        if (origin === bName) return;
        deliverUpdate(bDoc, update, aName, key);
      });

      bDoc.on("update", function handler(update: Uint8Array, origin: unknown) {
        if (origin === aName) return;
        deliverUpdate(aDoc, update, bName, key);
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
      const peerNames = [...peers.keys()];
      for (let i = 0; i < peerNames.length; i++) {
        for (let j = i + 1; j < peerNames.length; j++) {
          const a = peerNames[i]!;
          const b = peerNames[j]!;
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
          reconnectPair(peerNames[i]!, peerNames[j]!);
        }
      }
    },

    isConverged() {
      assertAlive();
      const peerList = [...peers.values()];
      if (peerList.length < 2) return true;

      for (const ch of channels) {
        const first = peerList[0]!.docs.get(ch)!;
        const firstSv = Y.encodeStateVector(first);
        for (let i = 1; i < peerList.length; i++) {
          const other = peerList[i]!.docs.get(ch)!;
          const otherSv = Y.encodeStateVector(other);
          if (!uint8Equal(firstSv, otherSv)) {
            return false;
          }
        }
      }
      return true;
    },

    settle() {
      if (destroyed || pendingTimers.size === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const check = () => {
          if (destroyed || pendingTimers.size === 0) {
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        setTimeout(check, 1);
      });
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
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
