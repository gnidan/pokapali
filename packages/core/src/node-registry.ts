/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PubSubLike } from "@pokapali/sync";
import type { Helia } from "helia";
import { createLogger } from "@pokapali/log";

const log = createLogger("node-registry");

export const NODE_CAPS_TOPIC = "pokapali._node-caps._p2p._pubsub";
const STALE_MS = 90_000;
const PRUNE_INTERVAL_MS = 30_000;

export interface Neighbor {
  peerId: string;
  role?: string;
}

export interface KnownNode {
  peerId: string;
  roles: string[];
  lastSeenAt: number;
  connected: boolean;
  neighbors: Neighbor[];
  browserCount: number | undefined;
  /** Public WSS addresses from caps broadcast. */
  addrs: string[];
  /** HTTPS block endpoint URL (e.g.
   *  https://host:4443) from caps v2. */
  httpUrl: string | undefined;
}

export interface NodeRegistry {
  /** All known non-stale nodes. */
  readonly nodes: ReadonlyMap<string, KnownNode>;
  /** Register a callback for meaningful changes. */
  onNodeChange(cb: () => void): void;
  /** Unregister a change callback. */
  offNodeChange(cb: () => void): void;
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
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as any).peerId === "string"
    ) {
      const n: Neighbor = {
        peerId: (item as any).peerId,
      };
      if (typeof (item as any).role === "string") {
        n.role = (item as any).role;
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

export function createNodeRegistry(
  pubsub: PubSubLike,
  getHelia: () => Helia,
): NodeRegistry {
  const nodes = new Map<string, KnownNode>();
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
      const conns = (helia as any).libp2p.getConnections();
      const pids = new Set<string>();
      for (const conn of conns) {
        pids.add((conn as any).remotePeer.toString());
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
    const changed =
      !prev ||
      prev.connected !== connected ||
      !rolesEqual(prev.roles, caps.roles);
    nodes.set(caps.peerId, {
      peerId: caps.peerId,
      roles: caps.roles,
      lastSeenAt: Date.now(),
      connected,
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

  // Prune stale entries and refresh connected state
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    const connectedPids = getConnectedPeerIds();
    let changed = false;
    for (const [pid, node] of nodes) {
      if (now - node.lastSeenAt > STALE_MS) {
        nodes.delete(pid);
        log.debug("pruned stale node:", pid.slice(-8));
        changed = true;
      } else {
        const wasConnected = node.connected;
        node.connected = connectedPids.has(pid);
        if (wasConnected !== node.connected) {
          changed = true;
        }
      }
    }
    if (changed) notifyChange();
  }, PRUNE_INTERVAL_MS);

  return {
    get nodes(): ReadonlyMap<string, KnownNode> {
      return nodes;
    },

    onNodeChange(cb: () => void) {
      changeListeners.add(cb);
    },

    offNodeChange(cb: () => void) {
      changeListeners.delete(cb);
    },

    destroy() {
      clearInterval(pruneTimer);
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

export function _resetNodeRegistry(): void {
  if (sharedRegistry) {
    sharedRegistry.destroy();
    sharedRegistry = null;
  }
}
