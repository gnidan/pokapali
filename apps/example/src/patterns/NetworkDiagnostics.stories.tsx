import type { Meta, StoryObj } from "@storybook/react";
import type { Diagnostics, VersionHistory } from "@pokapali/core";
import { TopologyMap } from "@pokapali/react/topology";
import { ConnectionStatusView, type History } from "../ConnectionStatus";
import { createMockTopologyDoc, healthyGraph } from "../mock-topology-doc";

/**
 * Network Diagnostics pattern — full bottom-panel
 * composition showing summary bar, sparkline graphs,
 * node list, and topology overview. Uses the real
 * ConnectionStatusView with a TopologyMap slot.
 */

const sparkHistory: History = {
  peers: [3, 4, 5, 5, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 10, 11, 11, 12, 12],
  mesh: [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6],
  nodes: [1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  clockSum: [
    10, 12, 15, 18, 22, 25, 28, 30, 33, 35, 38, 40, 42, 42, 42, 42, 42, 42, 42,
    42,
  ],
};

function mockDiagnostics(overrides?: Partial<Diagnostics>): Diagnostics {
  return {
    ipfsPeers: 12,
    editors: 2,
    gossipsub: {
      peers: 12,
      topics: 2,
      meshPeers: 6,
    },
    clockSum: 42,
    maxPeerClockSum: 42,
    latestAnnouncedSeq: 12,
    ipnsSeq: 5,
    loadingState: { status: "idle" },
    hasAppliedSnapshot: true,
    ackedBy: ["pinner-1"],
    guaranteeUntil: Date.now() + 86_400_000,
    retainUntil: Date.now() + 7 * 86_400_000,
    topology: [],
    nodes: [
      {
        peerId: "12D3KooWRelay1",
        short: "relay-1.pokapali.dev",
        connected: true,
        roles: ["relay"],
        rolesConfirmed: true,
        ackedCurrentCid: false,
        lastSeenAt: Date.now(),
        neighbors: [],
        browserCount: undefined,
      },
      {
        peerId: "12D3KooWRelay2",
        short: "relay-2.pokapali.dev",
        connected: true,
        roles: ["relay"],
        rolesConfirmed: true,
        ackedCurrentCid: false,
        lastSeenAt: Date.now(),
        neighbors: [],
        browserCount: undefined,
      },
      {
        peerId: "12D3KooWPinner1",
        short: "pinner-1.pokapali.dev",
        connected: true,
        roles: ["pinner"],
        rolesConfirmed: true,
        ackedCurrentCid: true,
        lastSeenAt: Date.now(),
        neighbors: [],
        browserCount: undefined,
      },
      {
        peerId: "12D3KooWRelay3",
        short: "relay-3.pokapali.dev",
        connected: true,
        roles: ["relay"],
        rolesConfirmed: true,
        ackedCurrentCid: false,
        lastSeenAt: Date.now(),
        neighbors: [],
        browserCount: undefined,
      },
    ],
    ...overrides,
  };
}

const emptyVersions: VersionHistory = {
  entries: [],
  walking: false,
};

const idleLoading = { status: "idle" as const };

function NetworkDiagnosticsPattern() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      {/* Healthy — full panel with topology */}
      <ConnectionStatusView
        info={mockDiagnostics()}
        history={sparkHistory}
        versions={emptyVersions}
        loading={idleLoading}
        canPushSnapshots={true}
        topologyMap={
          <div style={{ overflow: "hidden" }}>
            <TopologyMap doc={createMockTopologyDoc(healthyGraph)} />
          </div>
        }
      />

      {/* Degraded — partial connectivity */}
      <div>
        <code
          style={{
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
            display: "block",
            marginBottom: "0.5rem",
          }}
        >
          Degraded — partial node connectivity
        </code>
        <ConnectionStatusView
          info={mockDiagnostics({
            ipfsPeers: 3,
            gossipsub: {
              peers: 3,
              topics: 2,
              meshPeers: 1,
            },
            nodes: mockDiagnostics().nodes.map((n, i) => ({
              ...n,
              connected: i < 2,
            })),
          })}
          history={{
            peers: [3, 3, 2, 2, 3, 3, 3, 3, 3, 3],
            mesh: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            nodes: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
            clockSum: [30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
          }}
          versions={emptyVersions}
          loading={idleLoading}
          canPushSnapshots={true}
        />
      </div>

      {/* Disconnected — no peers */}
      <div>
        <code
          style={{
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
            display: "block",
            marginBottom: "0.5rem",
          }}
        >
          Disconnected — no nodes, no peers
        </code>
        <ConnectionStatusView
          info={mockDiagnostics({
            ipfsPeers: 0,
            gossipsub: {
              peers: 0,
              topics: 0,
              meshPeers: 0,
            },
            nodes: mockDiagnostics().nodes.map((n) => ({
              ...n,
              connected: false,
            })),
          })}
          history={{
            peers: [0, 0, 0, 0, 0],
            mesh: [0, 0, 0, 0, 0],
            nodes: [0, 0, 0, 0, 0],
            clockSum: [42, 42, 42, 42, 42],
          }}
          versions={emptyVersions}
          loading={idleLoading}
          canPushSnapshots={true}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof NetworkDiagnosticsPattern> = {
  title: "Patterns/Network Diagnostics",
  component: NetworkDiagnosticsPattern,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
