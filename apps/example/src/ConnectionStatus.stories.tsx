import type { Meta, StoryObj } from "@storybook/react";
import type { Diagnostics, VersionHistory } from "@pokapali/core";
import {
  ConnectionStatusView,
  type ConnectionStatusViewProps,
  type History,
} from "./ConnectionStatus";

// --- Mock data ---

const mockHistory: History = {
  peers: [2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 6, 7, 7, 8, 8, 7, 7, 8, 8, 8],
  mesh: [1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5],
  nodes: [1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  clockSum: [
    10, 12, 15, 18, 22, 25, 28, 30, 33, 35, 38, 40, 42, 42, 42, 42, 42, 42, 42,
    42,
  ],
};

function mockDiagnostics(overrides?: Partial<Diagnostics>): Diagnostics {
  return {
    ipfsPeers: 8,
    editors: 2,
    gossipsub: { peers: 12, topics: 2, meshPeers: 5 },
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
        connected: false,
        roles: ["relay"],
        rolesConfirmed: true,
        ackedCurrentCid: false,
        lastSeenAt: Date.now() - 30_000,
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

function defaultProps(
  overrides?: Partial<ConnectionStatusViewProps>,
): ConnectionStatusViewProps {
  return {
    info: mockDiagnostics(),
    history: mockHistory,
    versions: emptyVersions,
    loading: idleLoading,
    canPushSnapshots: true,
    ...overrides,
  };
}

// --- Stories ---

const meta: Meta<typeof ConnectionStatusView> = {
  title: "Components/ConnectionStatus",
  component: ConnectionStatusView,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  render: () => <ConnectionStatusView {...defaultProps()} />,
};

export const NoPinner: Story = {
  render: () => (
    <ConnectionStatusView
      {...defaultProps({
        info: mockDiagnostics({
          nodes: mockDiagnostics().nodes.filter(
            (n) => !n.roles.includes("pinner"),
          ),
        }),
      })}
    />
  ),
};

export const Behind: Story = {
  render: () => (
    <ConnectionStatusView
      {...defaultProps({
        info: mockDiagnostics({
          clockSum: 30,
          maxPeerClockSum: 42,
        }),
      })}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <ConnectionStatusView
      {...defaultProps({
        info: mockDiagnostics({
          hasAppliedSnapshot: false,
          loadingState: {
            status: "fetching",
            cid: "bafyreih5g7wxmq3a4k2vpe6e7lz",
            startedAt: Date.now() - 3000,
          },
        }),
      })}
    />
  ),
};

export const Disconnected: Story = {
  render: () => (
    <ConnectionStatusView
      {...defaultProps({
        info: mockDiagnostics({
          ipfsPeers: 0,
          gossipsub: { peers: 0, topics: 0, meshPeers: 0 },
          nodes: mockDiagnostics().nodes.map((n) => ({
            ...n,
            connected: false,
          })),
        }),
        history: {
          peers: [0, 0, 0, 0, 0],
          mesh: [0, 0, 0, 0, 0],
          nodes: [0, 0, 0, 0, 0],
          clockSum: [42, 42, 42, 42, 42],
        },
      })}
    />
  ),
};
