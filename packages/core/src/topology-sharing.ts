/**
 * Publish this browser's relay connections and
 * known infrastructure nodes via awareness so
 * other peers can build a full network graph.
 *
 * Each browser publishes:
 *   awareness.topology = {
 *     connectedRelays: [peerId, ...],
 *     relayRoles: { peerId: ["relay", ...] },
 *     knownNodes: [{ peerId, roles, ... }, ...]
 *   }
 */

import type { Awareness } from "y-protocols/awareness";
import type { NodeRegistry, Neighbor } from "./node-registry.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("topology-sharing");

const DEBOUNCE_MS = 2_000;
const NODE_DEBOUNCE_MS = 5_000;
const PERIODIC_MS = 30_000;

export interface TopologySharingOptions {
  awareness: Awareness;
  registry: NodeRegistry;
  /** libp2p instance for peer events. */
  libp2p: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addEventListener(type: string, fn: (evt: any) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeEventListener(type: string, fn: (evt: any) => void): void;
  };
}

export interface TopologySharing {
  /** Force an immediate publish. */
  publishNow(): void;
  destroy(): void;
}

/** Per-node entry published via awareness. */
/** Node info shared via awareness for topology
 *  graph construction by remote peers. */
export interface AwarenessKnownNode {
  peerId: string;
  roles: string[];
  neighbors: Neighbor[];
  browserCount?: number;
}

/**
 * Topology data published via awareness state so
 * peers can build a full network graph. Updated on
 * peer connect/disconnect and periodically.
 */
export interface AwarenessTopology {
  connectedRelays: string[];
  relayRoles: Record<string, string[]>;
  /** Infrastructure nodes from this browser's
   *  node-registry (caps messages received
   *  directly via GossipSub). */
  knownNodes?: AwarenessKnownNode[];
}

export function createTopologySharing(
  options: TopologySharingOptions,
): TopologySharing {
  const { awareness, registry, libp2p } = options;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let nodeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function publish() {
    const relays: string[] = [];
    const roles: Record<string, string[]> = {};
    for (const node of registry.nodes.values()) {
      if (!node.connected) continue;
      if (!node.roles.includes("relay") && !node.roles.includes("pinner")) {
        continue;
      }
      relays.push(node.peerId);
      roles[node.peerId] = node.roles;
    }
    // Snapshot all registry nodes for peers that
    // may not be directly connected to them.
    const knownNodes: AwarenessKnownNode[] = [];
    for (const node of registry.nodes.values()) {
      const entry: AwarenessKnownNode = {
        peerId: node.peerId,
        roles: node.roles,
        neighbors: node.neighbors,
      };
      if (node.browserCount != null) {
        entry.browserCount = node.browserCount;
      }
      knownNodes.push(entry);
    }
    const topo: AwarenessTopology = {
      connectedRelays: relays,
      relayRoles: roles,
      knownNodes,
    };
    awareness.setLocalStateField("topology", topo);
    log.debug(
      "published topology:",
      relays.length,
      "relays,",
      knownNodes.length,
      "known nodes",
    );
  }

  function schedulePublish() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      publish();
    }, DEBOUNCE_MS);
  }

  function scheduleNodePublish() {
    if (nodeDebounceTimer) {
      clearTimeout(nodeDebounceTimer);
    }
    nodeDebounceTimer = setTimeout(() => {
      nodeDebounceTimer = null;
      publish();
    }, NODE_DEBOUNCE_MS);
  }

  const connectHandler = () => schedulePublish();
  const disconnectHandler = () => schedulePublish();
  const nodeChangeHandler = () => scheduleNodePublish();

  libp2p.addEventListener("peer:connect", connectHandler);
  libp2p.addEventListener("peer:disconnect", disconnectHandler);
  registry.on("change", nodeChangeHandler);

  const periodicTimer = setInterval(publish, PERIODIC_MS);

  // Initial publish after a short delay to let
  // connections stabilize.
  const initialTimer = setTimeout(publish, DEBOUNCE_MS);

  return {
    publishNow() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (nodeDebounceTimer) {
        clearTimeout(nodeDebounceTimer);
        nodeDebounceTimer = null;
      }
      publish();
    },

    destroy() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (nodeDebounceTimer) {
        clearTimeout(nodeDebounceTimer);
        nodeDebounceTimer = null;
      }
      clearInterval(periodicTimer);
      clearTimeout(initialTimer);
      libp2p.removeEventListener("peer:connect", connectHandler);
      libp2p.removeEventListener("peer:disconnect", disconnectHandler);
      registry.off("change", nodeChangeHandler);
    },
  };
}
