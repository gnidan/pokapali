/**
 * Build a merged topology graph from diagnostics,
 * node-registry data, and awareness state.
 *
 * Extracted from index.ts to reduce file size.
 */

import { awarenessField } from "./awareness-state.js";

/** A node in the topology graph visualization. */
export interface TopologyNode {
  id: string;
  kind: "self" | "relay" | "pinner" | "relay+pinner" | "browser";
  label: string;
  connected: boolean;
  roles: string[];
  /** Awareness client ID (for browser nodes). */
  clientId?: number;
  ackedCurrentCid?: boolean;
  browserCount?: number;
}

/** A connection between two topology nodes. */
export interface TopologyEdge {
  source: string;
  target: string;
  connected: boolean;
}

/**
 * Full topology graph merging own connections,
 * peer awareness data, and relay-relay edges.
 * Returned by {@link Doc.topologyGraph}.
 */
export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

/** Raw topology edge from node capability
 *  broadcasts. */
export interface CapabilityEdge {
  source: string;
  target: string;
  targetRole?: string;
}

type NodeKind = TopologyNode["kind"];

export function nodeKind(roles: string[]): NodeKind {
  const isPinner = roles.includes("pinner");
  const isRelay = roles.includes("relay");
  if (isPinner && isRelay) return "relay+pinner";
  if (isPinner) return "pinner";
  if (isRelay) return "relay";
  return "browser";
}

/** Minimal diagnostics subset needed by the graph. */
export interface TopologyDiagnostics {
  nodes: Array<{
    peerId: string;
    short: string;
    connected: boolean;
    roles: string[];
    ackedCurrentCid: boolean;
    browserCount: number | undefined;
  }>;
  topology: CapabilityEdge[];
}

/** Minimal awareness interface for graph building. */
export interface TopologyAwareness {
  getStates(): Map<number, Record<string, unknown>>;
  clientID: number;
}

/**
 * Build a merged topology graph.
 *
 * Steps:
 * 1. Self node
 * 2. Infrastructure nodes from diagnostics
 * 3. Relay-relay edges from node neighbors
 * 4. Merge knownNodes from peers' awareness
 * 5. Browser peer nodes + relay edges
 */
export function buildTopologyGraph(
  info: TopologyDiagnostics,
  awareness: TopologyAwareness,
): TopologyGraph {
  const graphNodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const seenNodeIds = new Set<string>();

  // 1. Self node
  graphNodes.push({
    id: "_self",
    kind: "self",
    label: "You",
    connected: true,
    roles: [],
  });

  // 2. Infrastructure nodes from diagnostics
  for (const n of info.nodes) {
    seenNodeIds.add(n.peerId);
    graphNodes.push({
      id: n.peerId,
      kind: nodeKind(n.roles),
      label: `...${n.short}`,
      connected: n.connected,
      roles: n.roles,
      ackedCurrentCid: n.ackedCurrentCid,
      browserCount: n.browserCount,
    });
    edges.push({
      source: "_self",
      target: n.peerId,
      connected: n.connected,
    });
  }

  // 3. Relay-relay edges from node-registry
  for (const te of info.topology) {
    edges.push({
      source: te.source,
      target: te.target,
      connected: true,
    });
  }

  // 4. Merge knownNodes from all peers'
  //    awareness topology (last-write-wins
  //    by peerId). This surfaces infra nodes
  //    the local browser hasn't seen via caps.
  const states = awareness.getStates();
  const myClientId = awareness.clientID;

  for (const [clientId, state] of states) {
    if (clientId === myClientId) continue;
    const topo = awarenessField(state, "topology");
    if (!topo?.knownNodes) continue;
    for (const kn of topo.knownNodes) {
      if (typeof kn.peerId !== "string" || !Array.isArray(kn.roles)) {
        continue;
      }
      if (seenNodeIds.has(kn.peerId)) continue;
      seenNodeIds.add(kn.peerId);
      graphNodes.push({
        id: kn.peerId,
        kind: nodeKind(kn.roles),
        label: `...${kn.peerId.slice(-8)}`,
        connected: false,
        roles: kn.roles,
        browserCount: kn.browserCount,
      });
    }
  }

  // 5. Peer browser nodes + relay edges
  //    from awareness topology state.
  for (const [clientId, state] of states) {
    if (clientId === myClientId) continue;
    const topo = awarenessField(state, "topology");

    const peerId = `awareness:${clientId}`;
    graphNodes.push({
      id: peerId,
      kind: "browser",
      label: awarenessField(state, "user")?.name ?? `Peer ${clientId}`,
      connected: true,
      roles: [],
      clientId,
    });

    // Relay edges from this browser peer
    if (topo?.connectedRelays) {
      for (const relayPid of topo.connectedRelays) {
        // Ensure the relay node exists
        if (!seenNodeIds.has(relayPid)) {
          seenNodeIds.add(relayPid);
          const relayRoles = topo.relayRoles?.[relayPid] ?? [];
          graphNodes.push({
            id: relayPid,
            kind: nodeKind(relayRoles),
            label: `...${relayPid.slice(-8)}`,
            connected: false,
            roles: relayRoles,
          });
        }
        edges.push({
          source: peerId,
          target: relayPid,
          connected: true,
        });
      }
    }
  }

  return { nodes: graphNodes, edges };
}
