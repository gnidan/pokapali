import type { Meta, StoryObj } from "@storybook/react";
import { SaveIndicator, LastUpdated } from "@pokapali/react";
import type { SaveState } from "@pokapali/core";

const noop = () => {};

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
    note: "Unsaved changes — clickable button",
  },
  {
    saveState: "saving",
    ackCount: 0,
    note: "Write in progress",
  },
  {
    saveState: "unpublished",
    ackCount: 0,
    note: "Never saved — clickable button",
  },
  {
    saveState: "save-error",
    ackCount: 0,
    note: "Persistence failed",
  },
];

function SaveIndicatorStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>SaveIndicator</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Shows save/persistence state. Dirty and unpublished states render as a
        clickable button; others as a status label.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {states.map(({ saveState, ackCount, note }) => (
          <div
            key={`${saveState}-${ackCount}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1.5rem",
            }}
          >
            <div style={{ minWidth: 220 }}>
              <SaveIndicator
                saveState={saveState}
                ackCount={ackCount}
                onPublish={noop}
              />
            </div>
            <div>
              <code
                style={{
                  fontSize: "var(--poka-text-2xs)",
                  color: "var(--poka-text-secondary)",
                }}
              >
                saveState=&quot;{saveState}&quot;
                {ackCount > 0 && ` ackCount={${ackCount}}`}
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

      <h3
        style={{
          fontSize: "var(--poka-text-base)",
          color: "var(--poka-text-secondary)",
          marginTop: "1.5rem",
          marginBottom: "0.5rem",
        }}
      >
        LastUpdated
      </h3>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Read-only variant showing timestamp. Used when the user cannot edit
        (reader role). Flash state triggers a brief highlight animation.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.5rem",
          }}
        >
          <div style={{ minWidth: 220 }}>
            <LastUpdated timestamp={Date.now() - 30_000} flash={false} />
          </div>
          <code
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-secondary)",
            }}
          >
            flash=false
          </code>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.5rem",
          }}
        >
          <div style={{ minWidth: 220 }}>
            <LastUpdated timestamp={Date.now()} flash={true} />
          </div>
          <code
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-secondary)",
            }}
          >
            flash=true (highlight animation)
          </code>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof SaveIndicatorStories> = {
  title: "Components/SaveIndicator",
  component: SaveIndicatorStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};

export const Saved: Story = {
  render: () => (
    <SaveIndicator saveState="saved" ackCount={0} onPublish={noop} />
  ),
};

export const SavedWithAcks: Story = {
  render: () => (
    <SaveIndicator saveState="saved" ackCount={2} onPublish={noop} />
  ),
};

export const Dirty: Story = {
  render: () => (
    <SaveIndicator saveState="dirty" ackCount={0} onPublish={noop} />
  ),
};

export const Saving: Story = {
  render: () => (
    <SaveIndicator saveState="saving" ackCount={0} onPublish={noop} />
  ),
};

export const Unpublished: Story = {
  render: () => (
    <SaveIndicator saveState="unpublished" ackCount={0} onPublish={noop} />
  ),
};

export const SaveError: Story = {
  render: () => (
    <SaveIndicator saveState="save-error" ackCount={0} onPublish={noop} />
  ),
};
