import type { PubSubLike } from "@pokapali/sync";
import type { Helia } from "helia";
import { createLogger } from "@pokapali/log";

const log = createLogger("node-registry");

export const NODE_CAPS_TOPIC =
  "pokapali._node-caps._p2p._pubsub";
const STALE_MS = 90_000;
const PRUNE_INTERVAL_MS = 30_000;

export interface KnownNode {
  peerId: string;
  roles: string[];
  lastSeenAt: number;
  connected: boolean;
}

export interface NodeRegistry {
  /** All known non-stale nodes. */
  readonly nodes: ReadonlyMap<string, KnownNode>;
  destroy(): void;
}

interface NodeCapsMessage {
  version: 1;
  peerId: string;
  roles: string[];
}

function parseCapsMessage(
  data: Uint8Array,
): NodeCapsMessage | null {
  try {
    const obj = JSON.parse(
      new TextDecoder().decode(data),
    );
    if (
      obj?.version !== 1 ||
      typeof obj.peerId !== "string" ||
      !Array.isArray(obj.roles)
    ) {
      return null;
    }
    return obj as NodeCapsMessage;
  } catch {
    return null;
  }
}

export function createNodeRegistry(
  pubsub: PubSubLike,
  getHelia: () => Helia,
): NodeRegistry {
  const nodes = new Map<string, KnownNode>();

  pubsub.subscribe(NODE_CAPS_TOPIC);
  log.debug("subscribed to", NODE_CAPS_TOPIC);

  function getConnectedPeerIds(): Set<string> {
    try {
      const helia = getHelia();
      const conns =
        (helia as any).libp2p.getConnections();
      const pids = new Set<string>();
      for (const conn of conns) {
        pids.add(
          (conn as any).remotePeer.toString(),
        );
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

    const connected =
      getConnectedPeerIds().has(caps.peerId);
    nodes.set(caps.peerId, {
      peerId: caps.peerId,
      roles: caps.roles,
      lastSeenAt: Date.now(),
      connected,
    });
    log.debug(
      "node seen:",
      caps.peerId.slice(-8),
      caps.roles.join(","),
    );
  };

  pubsub.addEventListener("message", messageHandler);

  // Prune stale entries and refresh connected state
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    const connectedPids = getConnectedPeerIds();
    for (const [pid, node] of nodes) {
      if (now - node.lastSeenAt > STALE_MS) {
        nodes.delete(pid);
        log.debug("pruned stale node:", pid.slice(-8));
      } else {
        node.connected = connectedPids.has(pid);
      }
    }
  }, PRUNE_INTERVAL_MS);

  return {
    get nodes(): ReadonlyMap<string, KnownNode> {
      return nodes;
    },

    destroy() {
      clearInterval(pruneTimer);
      pubsub.removeEventListener(
        "message",
        messageHandler,
      );
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
    sharedRegistry = createNodeRegistry(
      pubsub,
      getHelia,
    );
  }
  return sharedRegistry;
}

export function getNodeRegistry():
  NodeRegistry | null {
  return sharedRegistry;
}

export function _resetNodeRegistry(): void {
  if (sharedRegistry) {
    sharedRegistry.destroy();
    sharedRegistry = null;
  }
}
