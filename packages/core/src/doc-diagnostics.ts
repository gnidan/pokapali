import type { Awareness } from "y-protocols/awareness";
import type { RoomDiscovery } from "./peer-discovery.js";
import type { LoadingState } from "./facts.js";
import type { TopologyEdge } from "./topology-graph.js";
import { getHelia } from "./helia.js";
import { getNodeRegistry } from "./node-registry.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("core:diagnostics");

export interface NodeInfo {
  peerId: string;
  short: string;
  connected: boolean;
  roles: string[];
  /** True after a caps broadcast confirms roles. */
  rolesConfirmed: boolean;
  ackedCurrentCid: boolean;
  lastSeenAt: number;
  /** Neighbors reported by this node (v2 caps). */
  neighbors: import("./node-registry.js").Neighbor[];
  /** Browser count reported by this node (v2 caps). */
  browserCount: number | undefined;
}

export interface GossipSubDiagnostic {
  peers: number;
  topics: number;
  meshPeers: number;
}

export interface Diagnostics {
  ipfsPeers: number;
  nodes: NodeInfo[];
  editors: number;
  gossipsub: GossipSubDiagnostic;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  ipnsSeq: number | null;
  loadingState: LoadingState;
  hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  ackedBy: string[];
  /** Latest guarantee-until timestamp across all
   *  pinners for the current CID, or null if none. */
  guaranteeUntil: number | null;
  /** Latest retain-until timestamp across all
   *  pinners for the current CID, or null if none. */
  retainUntil: number | null;
  /** Topology edges derived from node-reported
   *  neighbors. Each edge is [sourceId, targetId]. */
  topology: TopologyEdge[];
}

export interface DiagnosticsContext {
  ackedBy: ReadonlySet<string>;
  latestAnnouncedSeq: number;
  loadingState: LoadingState;
  hasAppliedSnapshot: boolean;
  guaranteeUntil: number | null;
  retainUntil: number | null;
  roomDiscovery: RoomDiscovery | undefined;
  awareness: Awareness;
  clockSum: number;
  ipnsSeq: number | null;
}

export function buildDiagnostics(ctx: DiagnosticsContext): Diagnostics {
  let ipfsPeers = 0;
  const nodeList: NodeInfo[] = [];
  let gossipsub: GossipSubDiagnostic = {
    peers: 0,
    topics: 0,
    meshPeers: 0,
  };

  const ackedSet = ctx.ackedBy;

  try {
    const helia = getHelia();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const libp2p = (helia as any).libp2p;
    ipfsPeers = libp2p.getPeers().length;

    // Build node list from registry
    const registry = getNodeRegistry();
    const seenPids = new Set<string>();
    if (registry) {
      for (const node of registry.nodes.values()) {
        seenPids.add(node.peerId);
        const acked = ackedSet.has(node.peerId);
        // If peer acked, it's a pinner even
        // if caps didn't include that role.
        const roles =
          acked && !node.roles.includes("pinner")
            ? [...node.roles, "pinner"]
            : node.roles;
        nodeList.push({
          peerId: node.peerId,
          short: node.peerId.slice(-8),
          connected: node.connected,
          roles,
          rolesConfirmed: true,
          ackedCurrentCid: acked,
          lastSeenAt: node.lastSeenAt,
          neighbors: node.neighbors,
          browserCount: node.browserCount,
        });
      }
    }

    // Merge DHT-discovered relays not yet in
    // the registry (before caps broadcast).
    // Roles unknown until caps arrives.
    const dhtRelays = ctx.roomDiscovery?.relayPeerIds;
    if (dhtRelays) {
      for (const pid of dhtRelays) {
        if (seenPids.has(pid)) continue;
        const conns = libp2p.getConnections();
        const connected = conns.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => c.remotePeer.toString() === pid,
        );
        const acked = ackedSet.has(pid);
        nodeList.push({
          peerId: pid,
          short: pid.slice(-8),
          connected,
          roles: acked ? ["relay", "pinner"] : ["relay"],
          rolesConfirmed: false,
          ackedCurrentCid: acked,
          lastSeenAt: 0,
          neighbors: [],
          browserCount: undefined,
        });
      }
    }

    try {
      const pubsub = libp2p.services.pubsub;
      const topics: string[] = pubsub.getTopics?.() ?? [];
      const gsPeers = pubsub.getPeers?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mesh = (pubsub as any).mesh as Map<string, Set<string>> | undefined;
      let meshPeers = 0;
      if (mesh) {
        for (const set of mesh.values()) {
          meshPeers += set.size;
        }
      }
      gossipsub = {
        peers: gsPeers.length,
        topics: topics.length,
        meshPeers,
      };
    } catch (err) {
      log.debug(
        "GossipSub internals unavailable:",
        (err as Error)?.message ?? err,
      );
    }
  } catch (err) {
    log.warn("diagnostics error:", (err as Error)?.message ?? err);
  }

  let maxPeerClockSum = 0;
  let editors = 1;
  try {
    const states = ctx.awareness.getStates();
    editors = Math.max(1, states.size);
    for (const [, state] of states) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (state as any)?.clockSum;
      if (typeof cs === "number" && cs > maxPeerClockSum) {
        maxPeerClockSum = cs;
      }
    }
  } catch (err) {
    log.debug("awareness unavailable:", (err as Error)?.message ?? err);
  }

  // Build topology edges from node neighbors
  const topology: TopologyEdge[] = [];
  for (const node of nodeList) {
    for (const nb of node.neighbors) {
      topology.push({
        source: node.peerId,
        target: nb.peerId,
        ...(nb.role ? { targetRole: nb.role } : {}),
      });
    }
  }

  return {
    ipfsPeers,
    nodes: nodeList,
    editors,
    gossipsub,
    clockSum: ctx.clockSum,
    maxPeerClockSum,
    latestAnnouncedSeq: ctx.latestAnnouncedSeq,
    ipnsSeq: ctx.ipnsSeq,
    loadingState: ctx.loadingState,
    hasAppliedSnapshot: ctx.hasAppliedSnapshot,
    ackedBy: [...ackedSet],
    guaranteeUntil: ctx.guaranteeUntil,
    retainUntil: ctx.retainUntil,
    topology,
  };
}
