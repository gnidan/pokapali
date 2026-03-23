import type { Meta, StoryObj } from "@storybook/react";
import { StatusIndicator } from "./StatusIndicator";

const meta: Meta<typeof StatusIndicator> = {
  title: "Components/StatusIndicator",
  component: StatusIndicator,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Synced: Story = {
  args: { status: "synced" },
};

export const Receiving: Story = {
  args: { status: "receiving" },
};

export const Connecting: Story = {
  args: { status: "connecting" },
};

export const Offline: Story = {
  args: { status: "offline" },
};
