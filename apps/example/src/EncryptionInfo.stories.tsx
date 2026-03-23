import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { EncryptionInfo, LockIcon } from "./EncryptionInfo";

function TriggerWithPopover() {
  const [open, setOpen] = useState(true);

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          fontSize: "var(--poka-text-xs)",
          color: "var(--poka-text-secondary)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "4px",
        }}
      >
        <LockIcon size={14} />
        Encrypted
      </button>
      {open && (
        <div style={{ maxWidth: 320 }}>
          <EncryptionInfo onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

const meta: Meta = {
  title: "Components/EncryptionInfo",
};

export default meta;
type Story = StoryObj;

export const TriggerAndPopover: Story = {
  render: () => <TriggerWithPopover />,
};

export const PopoverStatic: Story = {
  render: () => (
    <div style={{ maxWidth: 340 }}>
      <EncryptionInfo onClose={() => {}} />
    </div>
  ),
};

export const LockIconSizes: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1.5rem",
        color: "var(--poka-text-secondary)",
      }}
    >
      {[12, 16, 24].map((size) => (
        <div
          key={size}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <LockIcon size={size} />
          <span
            style={{
              fontSize: "var(--poka-text-2xs)",
            }}
          >
            {size}px{size === 16 ? " (default)" : ""}
          </span>
        </div>
      ))}
    </div>
  ),
};
