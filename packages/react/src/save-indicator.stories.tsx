/**
 * useSaveLabel + useLastUpdated hook stories — shows
 * how consumers derive save state labels and build
 * their own indicator UI.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { SaveState } from "@pokapali/core";
import { useSaveLabel } from "./use-save-label.js";
import { useLastUpdated } from "./use-last-updated.js";

// ── Hook demo components ────────────────────────

function SaveLabelDemo({
  saveState,
  ackCount,
}: {
  saveState: SaveState;
  ackCount: number;
}) {
  const { label, canPublish } = useSaveLabel(saveState, ackCount);

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
          "poka-save-indicator" +
          ` poka-save-indicator--${saveState}` +
          (canPublish ? " poka-save-indicator--action" : "")
        }
        role="status"
      >
        {label}
      </span>
      <code
        style={{
          fontSize: "var(--poka-text-2xs)",
          color: "var(--poka-text-muted)",
        }}
      >
        canPublish={String(canPublish)}
      </code>
    </div>
  );
}

function LastUpdatedDemo({
  timestamp,
  flash,
}: {
  timestamp: number;
  flash: boolean;
}) {
  const { label, age } = useLastUpdated(timestamp);

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
          "poka-last-updated" + (flash ? " poka-last-updated--flashing" : "")
        }
        aria-live="polite"
      >
        {label}
      </span>
      <code
        style={{
          fontSize: "var(--poka-text-2xs)",
          color: "var(--poka-text-muted)",
        }}
      >
        age=&quot;{age}&quot;
      </code>
    </div>
  );
}

// ── Meta ────────────────────────────────────────

const states: {
  saveState: SaveState;
  ackCount: number;
  note: string;
}[] = [
  {
    saveState: "saved",
    ackCount: 0,
    note: "All changes persisted locally",
  },
  {
    saveState: "saved",
    ackCount: 2,
    note: "Persisted + acknowledged by pinners",
  },
  {
    saveState: "dirty",
    ackCount: 0,
    note: "Unsaved changes — canPublish=true",
  },
  {
    saveState: "saving",
    ackCount: 0,
    note: "Write in progress",
  },
  {
    saveState: "unpublished",
    ackCount: 0,
    note: "Never saved — canPublish=true",
  },
  {
    saveState: "save-error",
    ackCount: 0,
    note: "Persistence failed",
  },
];

function AllSaveStates() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        padding: 16,
      }}
    >
      <h3 style={{ margin: 0 }}>useSaveLabel</h3>
      {states.map(({ saveState, ackCount, note }) => (
        <div key={`${saveState}-${ackCount}`}>
          <SaveLabelDemo saveState={saveState} ackCount={ackCount} />
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
      <h3 style={{ margin: "1rem 0 0" }}>useLastUpdated</h3>
      <LastUpdatedDemo timestamp={Date.now() - 30_000} flash={false} />
      <LastUpdatedDemo timestamp={Date.now()} flash={true} />
    </div>
  );
}

const meta: Meta<typeof AllSaveStates> = {
  title: "Hooks/useSaveLabel",
  component: AllSaveStates,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const Saved: Story = {
  render: () => <SaveLabelDemo saveState="saved" ackCount={0} />,
};

export const SavedWithAcks: Story = {
  render: () => <SaveLabelDemo saveState="saved" ackCount={2} />,
};

export const Dirty: Story = {
  render: () => <SaveLabelDemo saveState="dirty" ackCount={0} />,
};

export const Saving: Story = {
  render: () => <SaveLabelDemo saveState="saving" ackCount={0} />,
};

export const Unpublished: Story = {
  render: () => <SaveLabelDemo saveState="unpublished" ackCount={0} />,
};

export const SaveError: Story = {
  render: () => <SaveLabelDemo saveState="save-error" ackCount={0} />,
};
