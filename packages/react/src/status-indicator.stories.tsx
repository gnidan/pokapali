/**
 * useStatusLabel hook stories — shows how consumers
 * derive connection status labels and build their own
 * status indicator UI.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { DocStatus } from "@pokapali/core";
import { useStatusLabel } from "./use-status-label.js";

// ── Hook demo component ────────────────────────

function StatusLabelDemo({ status }: { status: DocStatus }) {
  const { label, warning, ariaLabel, degraded } = useStatusLabel(status);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
      }}
    >
      <span
        className={
          "poka-status-indicator" +
          ` poka-status-indicator--${status}` +
          (degraded ? " poka-status-indicator--degraded" : "")
        }
        role="status"
        aria-label={ariaLabel}
      >
        <span
          className={
            "poka-status-indicator__dot" +
            ` poka-status-indicator__dot--${status}`
          }
          aria-hidden="true"
        />
        <span className="poka-status-indicator__text">{label}</span>
        {warning && (
          <span className="poka-status-indicator__warning">{warning}</span>
        )}
      </span>
      <code
        style={{
          fontSize: "var(--poka-text-2xs)",
          color: "var(--poka-text-muted)",
        }}
      >
        degraded={String(degraded)}
      </code>
    </div>
  );
}

// ── Meta ────────────────────────────────────────

const statuses: {
  status: DocStatus;
  note: string;
}[] = [
  {
    status: "synced",
    note: "Connected, all changes propagated",
  },
  {
    status: "receiving",
    note: "Subscribed, receiving updates",
  },
  {
    status: "connecting",
    note: "Attempting connection — shows warning",
  },
  {
    status: "offline",
    note: "No connection — shows warning",
  },
];

function AllStatuses() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        padding: 16,
      }}
    >
      <h3 style={{ margin: 0 }}>useStatusLabel</h3>
      {statuses.map(({ status, note }) => (
        <div key={status}>
          <StatusLabelDemo status={status} />
          <div
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
              marginTop: 2,
              marginLeft: 4,
            }}
          >
            {note}
          </div>
        </div>
      ))}
    </div>
  );
}

const meta: Meta<typeof AllStatuses> = {
  title: "Hooks/useStatusLabel",
  component: AllStatuses,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const Synced: Story = {
  render: () => <StatusLabelDemo status="synced" />,
};

export const Receiving: Story = {
  render: () => <StatusLabelDemo status="receiving" />,
};

export const Connecting: Story = {
  render: () => <StatusLabelDemo status="connecting" />,
};

export const Offline: Story = {
  render: () => <StatusLabelDemo status="offline" />,
};
