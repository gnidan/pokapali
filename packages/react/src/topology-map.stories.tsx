/**
 * TopologyMap stories — organized by user scenario.
 * Answers: "Who else is here?"
 */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  TopologyGraph,
  TopologyNode,
  TopologyEdge,
  Feed,
} from "@pokapali/core";
import { TopologyMap } from "./topology-map.js";
import type { TopologyMapDoc } from "./topology-map.js";

// ── Mock helpers ────────────────────────────────

function mockFeed<T>(value: T): Feed<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}

function mockTopologyDoc(
  graph: TopologyGraph,
  opts?: {
    awarenessStates?: Map<number, Record<string, unknown>>;
    clientID?: number;
    canPushSnapshots?: boolean;
  },
): TopologyMapDoc {
  const clientID = opts?.clientID ?? 1;
  const states =
    opts?.awarenessStates ??
    new Map<number, Record<string, unknown>>([
      [clientID, { user: { name: "You", color: "#10b981" } }],
    ]);

  return {
    topologyGraph: () => graph,
    capability: {
      canPushSnapshots: opts?.canPushSnapshots ?? true,
    },
    snapshotEvents: mockFeed(null),
    tip: mockFeed(null),
    loading: mockFeed(null as never),
    gossipActivity: mockFeed("idle" as const as never),
    on: () => {},
    off: () => {},
    awareness: {
      on: () => {},
      off: () => {},
      getStates: () => states,
      clientID,
    },
  };
}

// ── Mock graphs ─────────────────────────────────

const SELF_NODE: TopologyNode = {
  id: "_self",
  kind: "self",
  label: "You",
  connected: true,
  roles: [],
};

const JUST_YOU: TopologyGraph = {
  nodes: [SELF_NODE],
  edges: [],
};

const TWO_EDITORS: TopologyGraph = {
  nodes: [
    SELF_NODE,
    {
      id: "awareness:2",
      kind: "browser",
      label: "Alice Chen",
      connected: true,
      roles: [],
      clientId: 2,
    },
    {
      id: "server-1",
      kind: "relay+pinner",
      label: "Server 1",
      connected: true,
      roles: ["relay", "pinner"],
      ackedCurrentCid: true,
    },
  ],
  edges: [
    {
      source: "_self",
      target: "server-1",
      connected: true,
    },
    {
      source: "awareness:2",
      target: "server-1",
      connected: true,
    },
  ],
};

const FULL_NETWORK: TopologyGraph = {
  nodes: [
    SELF_NODE,
    {
      id: "awareness:2",
      kind: "browser",
      label: "Alice Chen",
      connected: true,
      roles: [],
      clientId: 2,
    },
    {
      id: "awareness:3",
      kind: "browser",
      label: "Bob",
      connected: true,
      roles: [],
      clientId: 3,
    },
    {
      id: "server-1",
      kind: "relay+pinner",
      label: "Server 1",
      connected: true,
      roles: ["relay", "pinner"],
      ackedCurrentCid: true,
    },
    {
      id: "server-2",
      kind: "relay",
      label: "Server 2",
      connected: true,
      roles: ["relay"],
    },
    {
      id: "server-3",
      kind: "pinner",
      label: "Server 3",
      connected: true,
      roles: ["pinner"],
      ackedCurrentCid: true,
    },
  ],
  edges: [
    {
      source: "_self",
      target: "server-1",
      connected: true,
    },
    {
      source: "_self",
      target: "server-2",
      connected: true,
    },
    {
      source: "awareness:2",
      target: "server-1",
      connected: true,
    },
    {
      source: "awareness:3",
      target: "server-2",
      connected: true,
    },
    {
      source: "server-1",
      target: "server-2",
      connected: true,
    },
    {
      source: "server-1",
      target: "server-3",
      connected: true,
    },
  ],
};

const EDITOR_DISCONNECTED: TopologyGraph = {
  nodes: [
    SELF_NODE,
    {
      id: "awareness:2",
      kind: "browser",
      label: "Alice Chen",
      connected: false,
      roles: [],
      clientId: 2,
    },
    {
      id: "server-1",
      kind: "relay+pinner",
      label: "Server 1",
      connected: true,
      roles: ["relay", "pinner"],
      ackedCurrentCid: true,
    },
  ],
  edges: [
    {
      source: "_self",
      target: "server-1",
      connected: true,
    },
    {
      source: "awareness:2",
      target: "server-1",
      connected: false,
    },
  ],
};

const SERVER_DOWN: TopologyGraph = {
  nodes: [
    SELF_NODE,
    {
      id: "server-1",
      kind: "relay+pinner",
      label: "Server 1",
      connected: true,
      roles: ["relay", "pinner"],
      ackedCurrentCid: true,
    },
    {
      id: "server-2",
      kind: "relay",
      label: "Server 2",
      connected: true,
      roles: ["relay"],
    },
    {
      id: "server-3",
      kind: "pinner",
      label: "Server 3",
      connected: false,
      roles: ["pinner"],
    },
  ],
  edges: [
    {
      source: "_self",
      target: "server-1",
      connected: true,
    },
    {
      source: "_self",
      target: "server-2",
      connected: true,
    },
    {
      source: "server-1",
      target: "server-2",
      connected: true,
    },
    {
      source: "server-1",
      target: "server-3",
      connected: false,
    },
  ],
};

// ── Decorator ───────────────────────────────────

const decorator = (Story: React.ComponentType) => (
  <div
    style={{
      width: 440,
      height: 340,
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      overflow: "hidden",
    }}
  >
    <Story />
  </div>
);

// ── Meta ────────────────────────────────────────

const meta: Meta<typeof TopologyMap> = {
  component: TopologyMap,
  decorators: [decorator],
};

export default meta;
type Story = StoryObj<typeof TopologyMap>;

// ── Stories ─────────────────────────────────────

export const JustYou: Story = {
  name: "Network/Topology/Just You",
  args: {
    doc: mockTopologyDoc(JUST_YOU),
  },
};

export const TwoEditors: Story = {
  name: "Network/Topology/Two Editors",
  args: {
    doc: mockTopologyDoc(TWO_EDITORS, {
      awarenessStates: new Map([
        [
          1,
          {
            user: {
              name: "You",
              color: "#10b981",
            },
          },
        ],
        [
          2,
          {
            user: {
              name: "Alice Chen",
              color: "#6366f1",
            },
          },
        ],
      ]),
    }),
  },
};

export const FullNetwork: Story = {
  name: "Network/Topology/Full Network",
  args: {
    doc: mockTopologyDoc(FULL_NETWORK, {
      awarenessStates: new Map([
        [
          1,
          {
            user: {
              name: "You",
              color: "#10b981",
            },
          },
        ],
        [
          2,
          {
            user: {
              name: "Alice Chen",
              color: "#6366f1",
            },
          },
        ],
        [
          3,
          {
            user: {
              name: "Bob",
              color: "#f59e0b",
            },
          },
        ],
      ]),
    }),
  },
};

export const EditorDisconnected: Story = {
  name: "Network/Topology/Editor Disconnected",
  args: {
    doc: mockTopologyDoc(EDITOR_DISCONNECTED, {
      awarenessStates: new Map([
        [
          1,
          {
            user: {
              name: "You",
              color: "#10b981",
            },
          },
        ],
        [
          2,
          {
            user: {
              name: "Alice Chen",
              color: "#6366f1",
            },
          },
        ],
      ]),
    }),
  },
};

export const ServerDown: Story = {
  name: "Network/Topology/Server Down",
  args: {
    doc: mockTopologyDoc(SERVER_DOWN),
  },
};

export const SoloOffline: Story = {
  name: "Network/Topology/Solo Offline",
  args: {
    doc: mockTopologyDoc({
      nodes: [SELF_NODE],
      edges: [],
    }),
  },
};
