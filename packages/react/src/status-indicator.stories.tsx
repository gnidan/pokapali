/**
 * StatusIndicator stories — one per connection state.
 * Answers: "Am I connected?"
 */

import type { Meta, StoryObj } from "@storybook/react";
import { StatusIndicator } from "./status-indicator.js";

// ── Meta ────────────────────────────────────────

const meta: Meta<typeof StatusIndicator> = {
  component: StatusIndicator,
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: 16,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof StatusIndicator>;

// ── Stories ─────────────────────────────────────

export const Live: Story = {
  name: "Status/Connection/Live",
  args: { status: "synced" },
};

export const Connected: Story = {
  name: "Status/Connection/Connected",
  args: { status: "receiving" },
};

export const Connecting: Story = {
  name: "Status/Connection/Connecting",
  args: { status: "connecting" },
};

export const Offline: Story = {
  name: "Status/Connection/Offline",
  args: { status: "offline" },
};
