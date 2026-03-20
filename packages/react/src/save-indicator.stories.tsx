/**
 * SaveIndicator + LastUpdated stories — organized by
 * user journey around "Are my changes saved?"
 */

import type { Meta, StoryObj } from "@storybook/react";
import { SaveIndicator, LastUpdated } from "./save-indicator.js";

// ── Shared ──────────────────────────────────────

const noop = () => {};

const decorator = (Story: React.ComponentType) => (
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
);

// ── SaveIndicator Meta ──────────────────────────

const saveMeta: Meta<typeof SaveIndicator> = {
  component: SaveIndicator,
  decorators: [decorator],
};

export default saveMeta;
type SaveStory = StoryObj<typeof SaveIndicator>;

// ── Save State Stories ──────────────────────────

export const Saved: SaveStory = {
  name: "Status/Save State/Saved",
  args: {
    saveState: "saved",
    ackCount: 3,
    onPublish: noop,
  },
};

export const SavedLocally: SaveStory = {
  name: "Status/Save State/Saved Locally",
  args: {
    saveState: "saved",
    ackCount: 0,
    onPublish: noop,
  },
};

export const UnsavedChanges: SaveStory = {
  name: "Status/Save State/Unsaved Changes",
  args: {
    saveState: "dirty",
    ackCount: 0,
    onPublish: noop,
  },
};

export const Saving: SaveStory = {
  name: "Status/Save State/Saving",
  args: {
    saveState: "saving",
    ackCount: 0,
    onPublish: noop,
  },
};

export const NewDocument: SaveStory = {
  name: "Status/Save State/New Document",
  args: {
    saveState: "unpublished",
    ackCount: 0,
    onPublish: noop,
  },
};

export const SaveFailed: SaveStory = {
  name: "Status/Save State/Save Failed",
  args: {
    saveState: "save-error",
    ackCount: 0,
    onPublish: noop,
  },
};

// ── LastUpdated Stories ──────────────────────────

const lastUpdatedMeta: Meta<typeof LastUpdated> = {
  component: LastUpdated,
  decorators: [decorator],
};

// Storybook only supports one default export, so
// LastUpdated stories use render functions instead.

export const JustNow: StoryObj = {
  name: "Status/Last Updated/Just Now",
  render: () => <LastUpdated timestamp={Date.now() - 3_000} flash={false} />,
  decorators: [decorator],
};

export const Flashing: StoryObj = {
  name: "Status/Last Updated/Flashing",
  render: () => <LastUpdated timestamp={Date.now() - 500} flash={true} />,
  decorators: [decorator],
};
