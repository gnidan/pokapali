/**
 * Minimal mock implementing TopologyMapDoc for
 * Storybook stories. Returns a static topology
 * graph and inert feeds that never fire.
 */

import type {
  TopologyGraph,
  TopologyNode,
  TopologyEdge,
  Feed,
  SnapshotEvent,
  GossipActivity,
  LoadingState,
  VersionInfo,
} from "@pokapali/core";
import type { TopologyMapDoc } from "@pokapali/react/topology";

function staticFeed<T>(value: T): Feed<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}

const noopOn = () => {};
const noopOff = () => {};

export function createMockTopologyDoc(
  graph: TopologyGraph,
  opts: {
    canPushSnapshots?: boolean;
    awarenessClientID?: number;
    awarenessStates?: Map<number, Record<string, unknown>>;
  } = {},
): TopologyMapDoc {
  const {
    canPushSnapshots = true,
    awarenessClientID = 1,
    awarenessStates = new Map([[1, {}]]),
  } = opts;

  return {
    topologyGraph: () => graph,
    capability: { canPushSnapshots },
    snapshotEvents: staticFeed(null as SnapshotEvent | null),
    tip: staticFeed(null as VersionInfo | null),
    loading: staticFeed({
      status: "idle",
    } as LoadingState),
    gossipActivity: staticFeed("inactive" as GossipActivity),
    on: noopOn,
    off: noopOff,
    awareness: {
      on: noopOn,
      off: noopOff,
      getStates: () => awarenessStates,
      clientID: awarenessClientID,
    },
  };
}

// ── Sample graphs ──────────────────────────────

const selfNode: TopologyNode = {
  id: "self",
  kind: "self",
  label: "You",
  connected: true,
  roles: [],
  clientId: 1,
};

export const healthyGraph: TopologyGraph = {
  nodes: [
    selfNode,
    {
      id: "relay-1",
      kind: "relay",
      label: "relay-1.pokapali.dev",
      connected: true,
      roles: ["relay"],
    },
    {
      id: "relay-2",
      kind: "relay",
      label: "relay-2.pokapali.dev",
      connected: true,
      roles: ["relay"],
    },
    {
      id: "pinner-1",
      kind: "pinner",
      label: "pinner-1.pokapali.dev",
      connected: true,
      roles: ["pinner"],
      ackedCurrentCid: true,
    },
    {
      id: "browser-2",
      kind: "browser",
      label: "Another editor",
      connected: true,
      roles: [],
      clientId: 2,
    },
  ],
  edges: [
    {
      source: "self",
      target: "relay-1",
      connected: true,
    },
    {
      source: "self",
      target: "relay-2",
      connected: true,
    },
    {
      source: "relay-1",
      target: "pinner-1",
      connected: true,
    },
    {
      source: "relay-2",
      target: "pinner-1",
      connected: true,
    },
    {
      source: "browser-2",
      target: "relay-1",
      connected: true,
    },
  ],
};

export const degradedGraph: TopologyGraph = {
  nodes: [
    selfNode,
    {
      id: "relay-1",
      kind: "relay",
      label: "relay-1.pokapali.dev",
      connected: true,
      roles: ["relay"],
    },
    {
      id: "relay-2",
      kind: "relay",
      label: "relay-2.pokapali.dev",
      connected: false,
      roles: ["relay"],
    },
    {
      id: "pinner-1",
      kind: "pinner",
      label: "pinner-1.pokapali.dev",
      connected: false,
      roles: ["pinner"],
    },
  ],
  edges: [
    {
      source: "self",
      target: "relay-1",
      connected: true,
    },
    {
      source: "self",
      target: "relay-2",
      connected: false,
    },
    {
      source: "relay-1",
      target: "pinner-1",
      connected: false,
    },
  ],
};

export const soloGraph: TopologyGraph = {
  nodes: [selfNode],
  edges: [],
};
