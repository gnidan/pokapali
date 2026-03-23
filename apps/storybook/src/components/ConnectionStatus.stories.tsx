import type { Meta, StoryObj } from "@storybook/react";
import { Dot, Sparkline } from "../helpers/story-helpers";

/**
 * Inline ConnectionStatus story — renders the
 * diagnostics panel with mock sparkline data and
 * node list. The real component depends on live
 * Doc feeds, so we render the visual structure
 * statically.
 */

// Mock sparkline data
const peerData = [2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 6, 7, 7, 8, 8, 7, 7, 8, 8, 8];
const meshData = [1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5];
const nodeData = [1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];

function ConnectionStatusStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>ConnectionStatus</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Bottom panel showing network diagnostics: node list with connection
        dots, sparkline history for peers/mesh/nodes, and topology map.
        Auto-hides when connection is healthy.
      </p>

      {/* Diagnostics panel mock */}
      <div
        style={{
          maxWidth: 480,
          background: "var(--poka-bg-surface)",
          border: "1px solid var(--poka-border-default)",
          borderRadius: "var(--poka-radius-lg)",
          padding: "var(--poka-space-4)",
        }}
      >
        <h3
          style={{
            fontSize: "var(--poka-text-sm)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            color: "var(--poka-text-primary)",
            marginBottom: "var(--poka-space-3)",
          }}
        >
          Network diagnostics
        </h3>

        {/* Summary row */}
        <div
          style={{
            display: "flex",
            gap: "var(--poka-space-4)",
            marginBottom: "var(--poka-space-3)",
            fontSize: "var(--poka-text-xs)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
              color: "var(--poka-text-secondary)",
            }}
          >
            <Dot state="connected" />
            Network: 8 peers, 5 mesh
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-1)",
              color: "var(--poka-text-secondary)",
            }}
          >
            <Dot state="connected" />
            Nodes: 4 connected
          </span>
        </div>

        {/* Node list */}
        <div
          style={{
            fontSize: "var(--poka-text-xs)",
            color: "var(--poka-text-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--poka-space-1)",
            marginBottom: "var(--poka-space-3)",
            padding: "var(--poka-space-2)",
            background: "var(--poka-bg-subtle)",
            borderRadius: "var(--poka-radius-md)",
          }}
        >
          {[
            {
              label: "relay-1.pokapali.dev",
              state: "connected" as const,
              role: "relay",
            },
            {
              label: "relay-2.pokapali.dev",
              state: "connected" as const,
              role: "relay",
            },
            {
              label: "pinner-1.pokapali.dev",
              state: "connected" as const,
              role: "pinner",
            },
            {
              label: "relay-3.pokapali.dev",
              state: "partial" as const,
              role: "relay",
            },
            {
              label: "relay-4.pokapali.dev",
              state: "disconnected" as const,
              role: "relay",
            },
          ].map(({ label, state, role }) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--poka-space-2)",
                padding: "2px 0",
              }}
            >
              <Dot state={state} />
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "var(--poka-text-2xs)",
                }}
              >
                {label}
              </span>
              <span
                style={{
                  fontSize: "var(--poka-text-2xs)",
                  color: "var(--poka-text-muted)",
                }}
              >
                ({role})
              </span>
            </div>
          ))}
        </div>

        {/* Sparklines */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--poka-space-2)",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                marginBottom: 2,
              }}
            >
              <span>Peers</span>
              <span>{peerData[peerData.length - 1]}</span>
            </div>
            <Sparkline data={peerData} color="var(--poka-color-synced)" />
          </div>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                marginBottom: 2,
              }}
            >
              <span>Mesh</span>
              <span>{meshData[meshData.length - 1]}</span>
            </div>
            <Sparkline data={meshData} color="var(--poka-color-receiving)" />
          </div>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                marginBottom: 2,
              }}
            >
              <span>Nodes</span>
              <span>{nodeData[nodeData.length - 1]}</span>
            </div>
            <Sparkline data={nodeData} color="var(--poka-color-connecting)" />
          </div>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof ConnectionStatusStories> = {
  title: "Components/ConnectionStatus",
  component: ConnectionStatusStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
