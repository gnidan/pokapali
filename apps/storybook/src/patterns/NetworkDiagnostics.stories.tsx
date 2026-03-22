import type { Meta, StoryObj } from "@storybook/react";
import { TopologyMap } from "@pokapali/react/topology";
import {
  createMockTopologyDoc,
  healthyGraph,
} from "../helpers/mock-topology-doc";
import { Dot, Sparkline } from "../helpers/story-helpers";

/**
 * Network Diagnostics pattern — full bottom-panel
 * composition showing summary bar, sparkline graphs,
 * node list, and topology overview. Mirrors the
 * ConnectionStatus layout from the example app.
 */

const peerData = [
  3, 4, 5, 5, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 10, 11, 11, 12, 12,
];
const meshData = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6];
const nodeData = [1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];

const nodes = [
  {
    label: "relay-1.pokapali.dev",
    role: "relay",
    state: "connected" as const,
  },
  {
    label: "relay-2.pokapali.dev",
    role: "relay",
    state: "connected" as const,
  },
  {
    label: "pinner-1.pokapali.dev",
    role: "pinner",
    state: "connected" as const,
  },
  {
    label: "relay-3.pokapali.dev",
    role: "relay",
    state: "partial" as const,
  },
  {
    label: "relay-4.pokapali.dev",
    role: "relay",
    state: "disconnected" as const,
  },
];

function NetworkDiagnosticsPatterns() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Network Diagnostics</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Bottom-panel diagnostics composition: summary bar with health
        indicators, expandable detail area with sparkline metrics, node list,
        and topology map. Shows real-time P2P network health.
      </p>

      {/* Full diagnostics panel */}
      <div
        style={{
          background: "var(--poka-bg-surface)",
          border: "1px solid var(--poka-border-default)",
          borderRadius: "var(--poka-radius-lg)",
          overflow: "hidden",
        }}
      >
        {/* Summary bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--poka-space-4)",
            padding: "var(--poka-space-2) " + "var(--poka-space-4)",
            borderBottom: "1px solid " + "var(--poka-border-default)",
            fontSize: "var(--poka-text-xs)",
            color: "var(--poka-text-secondary)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="connected" />
            Pokapali nodes: 4 connected
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="connected" />
            libp2p network: 12 peers, 6 mesh
          </span>
          <span style={{ marginLeft: "auto" }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--poka-space-1)",
              }}
            >
              <Dot state="connected" />
              Sync: up to date
            </span>
          </span>
        </div>

        {/* Detail area */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "var(--poka-space-4)",
            padding: "var(--poka-space-4)",
          }}
        >
          {/* Sparklines */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--poka-space-3)",
            }}
          >
            <span
              style={{
                fontSize: "var(--poka-text-xs)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
                marginBottom: "var(--poka-space-1)",
              }}
            >
              Network metrics
            </span>
            <Sparkline
              data={peerData}
              color="var(--poka-color-synced)"
              label="Peers"
              current={12}
              width={240}
              height={36}
            />
            <Sparkline
              data={meshData}
              color="var(--poka-color-receiving)"
              label="Mesh"
              current={6}
              width={240}
              height={36}
            />
            <Sparkline
              data={nodeData}
              color="var(--poka-color-connecting)"
              label="Nodes"
              current={4}
              width={240}
              height={36}
            />
          </div>

          {/* Node list */}
          <div>
            <span
              style={{
                fontSize: "var(--poka-text-xs)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
                display: "block",
                marginBottom: "var(--poka-space-2)",
              }}
            >
              Pokapali nodes
            </span>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--poka-space-1)",
                padding: "var(--poka-space-2)",
                background: "var(--poka-bg-subtle)",
                borderRadius: "var(--poka-radius-md)",
              }}
            >
              {nodes.map((n) => (
                <div
                  key={n.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--poka-space-2)",
                    padding: "2px 0",
                    fontSize: "var(--poka-text-2xs)",
                  }}
                >
                  <Dot state={n.state} />
                  <span
                    style={{
                      fontFamily: "monospace",
                      color: "var(--poka-text-secondary)",
                    }}
                  >
                    {n.label}
                  </span>
                  <span
                    style={{
                      color: "var(--poka-text-muted)",
                    }}
                  >
                    ({n.role})
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Topology */}
          <div>
            <span
              style={{
                fontSize: "var(--poka-text-xs)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
                display: "block",
                marginBottom: "var(--poka-space-2)",
              }}
            >
              Topology
            </span>
            <div
              style={{
                background: "var(--poka-bg-subtle)",
                borderRadius: "var(--poka-radius-md)",
                padding: "var(--poka-space-2)",
              }}
            >
              <div style={{ width: "100%", height: 140, overflow: "hidden" }}>
                <TopologyMap doc={createMockTopologyDoc(healthyGraph)} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Degraded state */}
      <div>
        <code
          style={{
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
            display: "block",
            marginBottom: "0.5rem",
          }}
        >
          Degraded — partial node connectivity, low peer count
        </code>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--poka-space-4)",
            padding: "var(--poka-space-2) " + "var(--poka-space-4)",
            background: "var(--poka-bg-surface)",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            fontSize: "var(--poka-text-xs)",
            color: "var(--poka-text-secondary)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="partial" />
            Pokapali nodes: 2 connected
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="partial" />
            libp2p network: 3 peers, 1 mesh
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
              marginLeft: "auto",
              color: "var(--poka-color-connecting)",
            }}
          >
            <Dot state="partial" />
            Sync: pending
          </span>
        </div>
      </div>

      {/* Disconnected state */}
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--poka-space-4)",
            padding: "var(--poka-space-2) " + "var(--poka-space-4)",
            background: "var(--poka-bg-surface)",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            fontSize: "var(--poka-text-xs)",
            color: "var(--poka-text-secondary)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="disconnected" />
            Pokapali nodes: 0 connected
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
            }}
          >
            <Dot state="disconnected" />
            libp2p network: 0 peers
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
              marginLeft: "auto",
              color: "var(--poka-color-offline)",
            }}
          >
            <Dot state="disconnected" />
            Sync: offline
          </span>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof NetworkDiagnosticsPatterns> = {
  title: "Patterns/Network Diagnostics",
  component: NetworkDiagnosticsPatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
