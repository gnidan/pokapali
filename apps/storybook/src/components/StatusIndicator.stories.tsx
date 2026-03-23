import type { Meta, StoryObj } from "@storybook/react";
import { StatusIndicator } from "@pokapali/react";
import type { DocStatus } from "@pokapali/core";

const statuses: {
  status: DocStatus;
  note: string;
}[] = [
  { status: "synced", note: "Connected, all changes propagated" },
  { status: "receiving", note: "Subscribed, receiving updates" },
  {
    status: "connecting",
    note: "Attempting connection — shows warning",
  },
  {
    status: "offline",
    note: "No connection — shows warning",
  },
];

function StatusIndicatorStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>StatusIndicator</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Dot + label showing connection status. Degraded states (connecting,
        offline) show a warning message on a tinted background.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {statuses.map(({ status, note }) => (
          <div
            key={status}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1.5rem",
            }}
          >
            <div style={{ minWidth: 280 }}>
              <StatusIndicator status={status} />
            </div>
            <div>
              <code
                style={{
                  fontSize: "var(--poka-text-2xs)",
                  color: "var(--poka-text-secondary)",
                }}
              >
                status=&quot;{status}&quot;
              </code>
              <div
                style={{
                  fontSize: "var(--poka-text-2xs)",
                  color: "var(--poka-text-muted)",
                  marginTop: "0.15rem",
                }}
              >
                {note}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof StatusIndicatorStories> = {
  title: "Components/StatusIndicator",
  component: StatusIndicatorStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};

export const Synced: Story = {
  render: () => <StatusIndicator status="synced" />,
};

export const Receiving: Story = {
  render: () => <StatusIndicator status="receiving" />,
};

export const Connecting: Story = {
  render: () => <StatusIndicator status="connecting" />,
};

export const Offline: Story = {
  render: () => <StatusIndicator status="offline" />,
};
