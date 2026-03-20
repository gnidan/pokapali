import type { PubSubLike } from "@pokapali/sync";
import type { Helia } from "helia";
import { createLogger } from "@pokapali/log";
import { createThrottledInterval } from "./throttled-interval.js";

const log = createLogger("node-registry");

/** GossipSub topic for node capability broadcasts. */
export const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";
/** Node becomes stale (greyed out) after this long
 *  without a caps broadcast. 5x the 30s caps interval
 *  gives margin for dropped GossipSub messages. */
const STALE_MS = 150_000;
/** Hard-remove threshold — stale nodes linger in
 *  the registry (visible but greyed) until this. */
const REMOVE_MS = 300_000;
const PRUNE_INTERVAL_MS = 30_000;
/** Consecutive disconnected prune checks required
 *  before flipping connected → false. Prevents
 *  single-check flicker from transient hiccups. */
const DISCONNECT_HYSTERESIS = 2;

/** A neighbor reported by a relay node in v2 caps. */
export interface Neighbor {
  peerId: string;
  role?: string;
}

/** A relay or pinner node discovered via GossipSub
 *  capability broadcasts. */
export interface KnownNode {
  peerId: string;
  roles: string[];
  lastSeenAt: number;
  connected: boolean;
  /** True when no caps broadcast received within
   *  STALE_MS but not yet hard-removed. Node remains
   *  in registry so the graph can show it greyed. */
  stale: boolean;
  neighbors: Neighbor[];
  browserCount: number | undefined;
  /** Public WSS addresses from caps broadcast. */
  addrs: string[];
  /** HTTPS block endpoint URL (e.g.
   *  https://host:4443) from caps v2. */
  httpUrl: string | undefined;
}

/** Events emitted by {@link NodeRegistry}. */
export interface NodeRegistryEvents {
  change: [];
}

/**
 * Tracks known relay and pinner nodes via GossipSub
 * capability broadcasts. Per-Helia singleton.
 */
export interface NodeRegistry {
  /** All known non-stale nodes. */
  readonly nodes: ReadonlyMap<string, KnownNode>;
  /** Register a callback for meaningful changes. */
  on<E extends keyof NodeRegistryEvents>(
    event: E,
    cb: (...args: NodeRegistryEvents[E]) => void,
  ): void;
  /** Unregister a change callback. */
  off<E extends keyof NodeRegistryEvents>(
    event: E,
    cb: (...args: NodeRegistryEvents[E]) => void,
  ): void;
  destroy(): void;
}

interface NodeCapsMessage {
  version: 1 | 2;
  peerId: string;
  roles: string[];
  neighbors?: Neighbor[];
  browserCount?: number;
  addrs?: string[];
  httpUrl?: string;
}

function parseNeighbors(arr: unknown): Neighbor[] {
  if (!Array.isArray(arr)) return [];
  const result: Neighbor[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.peerId === "string") {
      const n: Neighbor = { peerId: obj.peerId };
      if (typeof obj.role === "string") {
        n.role = obj.role;
      }
      result.push(n);
    }
  }
  return result;
}

function parseCapsMessage(data: Uint8Array): NodeCapsMessage | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(data));
    if (
      (obj?.version !== 1 && obj?.version !== 2) ||
      typeof obj.peerId !== "string" ||
      !Array.isArray(obj.roles)
    ) {
      return null;
    }
    const msg: NodeCapsMessage = {
      version: obj.version,
      peerId: obj.peerId,
      roles: obj.roles,
    };
    if (obj.version === 2) {
      msg.neighbors = parseNeighbors(obj.neighbors);
      if (typeof obj.browserCount === "number") {
        msg.browserCount = obj.browserCount;
      }
      if (Array.isArray(obj.addrs)) {
        msg.addrs = obj.addrs.filter((a: unknown) => typeof a === "string");
      }
      if (typeof obj.httpUrl === "string") {
        msg.httpUrl = obj.httpUrl;
      }
    }
    return msg;
  } catch {
    return null;
  }
}

function rolesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function neighborsEqual(a: Neighbor[], b: Neighbor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.peerId !== b[i]!.peerId) return false;
    if (a[i]!.role !== b[i]!.role) return false;
  }
  return true;
}

function addrsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createNodeRegistry(
  pubsub: PubSubLike,
  getHelia: () => Helia,
): NodeRegistry {
  const nodes = new Map<string, KnownNode>();
  /** Consecutive prune checks where the peer was not
   *  in the libp2p connection list. Reset to 0 on
   *  each caps message or when connection is seen. */
  const disconnectCounts = new Map<string, number>();
  const changeListeners = new Set<() => void>();

  function notifyChange() {
    for (const cb of changeListeners) {
      try {
        cb();
      } catch (err) {
        log.warn("change listener error:", (err as Error)?.message ?? err);
      }
    }
  }

  pubsub.subscribe(NODE_CAPS_TOPIC);
  log.debug("subscribed to", NODE_CAPS_TOPIC);

  function getConnectedPeerIds(): Set<string> {
    try {
      const helia = getHelia();
      const conns = helia.libp2p.getConnections();
      const pids = new Set<string>();
      for (const conn of conns) {
        pids.add(conn.remotePeer.toString());
      }
      return pids;
    } catch {
      return new Set();
    }
  }

  const messageHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== NODE_CAPS_TOPIC) return;

    const caps = parseCapsMessage(detail.data);
    if (!caps) return;

    const connected = getConnectedPeerIds().has(caps.peerId);
    const prev = nodes.get(caps.peerId);
    const newNeighbors = caps.neighbors ?? [];
    const newAddrs = caps.addrs ?? [];
    const changed =
      !prev ||
      prev.connected !== connected ||
      prev.stale ||
      !rolesEqual(prev.roles, caps.roles) ||
      !neighborsEqual(prev.neighbors, newNeighbors) ||
      prev.browserCount !== caps.browserCount ||
      prev.httpUrl !== caps.httpUrl ||
      !addrsEqual(prev.addrs, newAddrs);
    // Fresh caps broadcast — reset hysteresis and
    // clear stale flag.
    disconnectCounts.delete(caps.peerId);
    nodes.set(caps.peerId, {
      peerId: caps.peerId,
      roles: caps.roles,
      lastSeenAt: Date.now(),
      connected,
      stale: false,
      neighbors: caps.neighbors ?? [],
      browserCount: caps.browserCount,
      addrs: caps.addrs ?? [],
      httpUrl: caps.httpUrl,
    });
    if (!prev) {
      log.info(
        "node discovered:",
        caps.peerId.slice(-8),
        caps.roles.join(","),
        connected ? "(connected)" : "(not connected)",
      );
    } else {
      log.debug("node seen:", caps.peerId.slice(-8), caps.roles.join(","));
    }
    if (changed) {
      notifyChange();
    }
  };

  pubsub.addEventListener("message", messageHandler);

  // Prune stale entries and refresh connected state.
  // Paused when the tab is hidden — no point pruning
  // an invisible graph.
  const pruneTimer = createThrottledInterval(
    () => {
      const now = Date.now();
      const connectedPids = getConnectedPeerIds();
      let changed = false;
      for (const [pid, node] of nodes) {
        const age = now - node.lastSeenAt;

        // Hard-remove: no caps for REMOVE_MS
        if (age > REMOVE_MS) {
          nodes.delete(pid);
          disconnectCounts.delete(pid);
          log.debug("removed node:", pid.slice(-8));
          changed = true;
          continue;
        }

        // Mark stale (greyed in graph, still visible)
        if (age > STALE_MS && !node.stale) {
          node.stale = true;
          log.debug("stale node:", pid.slice(-8));
          changed = true;
        }

        // Connected state with hysteresis
        const isConnected = connectedPids.has(pid);
        if (isConnected) {
          // Connection confirmed — reset counter
          disconnectCounts.delete(pid);
          if (!node.connected) {
            node.connected = true;
            changed = true;
          }
        } else if (node.connected) {
          // Not connected — increment counter,
          // only flip after DISCONNECT_HYSTERESIS
          // consecutive checks.
          const count = (disconnectCounts.get(pid) ?? 0) + 1;
          disconnectCounts.set(pid, count);
          if (count >= DISCONNECT_HYSTERESIS) {
            node.connected = false;
            changed = true;
          }
        }
      }
      if (changed) notifyChange();
    },
    PRUNE_INTERVAL_MS,
    { backgroundMs: 0, fireOnResume: true },
  );

  return {
    get nodes(): ReadonlyMap<string, KnownNode> {
      return nodes;
    },

    on(_event: "change", cb: () => void) {
      changeListeners.add(cb);
    },

    off(_event: "change", cb: () => void) {
      changeListeners.delete(cb);
    },

    destroy() {
      pruneTimer.destroy();
      changeListeners.clear();
      pubsub.removeEventListener("message", messageHandler);
    },
  };
}

// --- Singleton management ---

let sharedRegistry: NodeRegistry | null = null;

export function acquireNodeRegistry(
  pubsub: PubSubLike,
  getHelia: () => Helia,
): NodeRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createNodeRegistry(pubsub, getHelia);
  }
  return sharedRegistry;
}

export function getNodeRegistry(): NodeRegistry | null {
  return sharedRegistry;
}
