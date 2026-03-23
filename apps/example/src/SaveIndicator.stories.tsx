import type { Meta, StoryObj } from "@storybook/react";
import type { SaveState } from "@pokapali/core";
import { SaveIndicator, LastUpdated } from "./SaveIndicator";

const noop = () => {};

const meta: Meta<typeof SaveIndicator> = {
  title: "Components/SaveIndicator",
  component: SaveIndicator,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  args: { saveState: "saved", ackCount: 0, onPublish: noop },
};

export const SavedWithAcks: Story = {
  args: { saveState: "saved", ackCount: 2, onPublish: noop },
};

export const Dirty: Story = {
  args: { saveState: "dirty", ackCount: 0, onPublish: noop },
};

export const Saving: Story = {
  args: {
    saveState: "saving",
    ackCount: 0,
    onPublish: noop,
  },
};

export const Unpublished: Story = {
  args: {
    saveState: "unpublished",
    ackCount: 0,
    onPublish: noop,
  },
};

export const SaveError: Story = {
  args: {
    saveState: "save-error",
    ackCount: 0,
    onPublish: noop,
  },
};

export const JustNow: Story = {
  render: () => <LastUpdated timestamp={Date.now() - 3_000} flash={false} />,
};

export const Flashing: Story = {
  render: () => <LastUpdated timestamp={Date.now()} flash={true} />,
};
