import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { LockIcon } from "../helpers/story-helpers";

/**
 * Inline EncryptionInfo for Storybook —
 * the real component lives in apps/example.
 */

function EncryptionInfoPopover({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="encryption-popover"
      role="dialog"
      aria-modal="true"
      aria-label="Encryption information"
      style={{ position: "relative", top: "auto", right: "auto" }}
    >
      <div className="encryption-header">
        <LockIcon size={16} />
        End-to-end encrypted
      </div>
      <p>
        Relay and pinner nodes cannot read your content &mdash; they only store
        encrypted blocks.
      </p>
      <p>
        Only people with the document link can read it. Your link determines
        your access level: admin, writer, or reader.
      </p>
      <button className="encryption-close" onClick={onClose} aria-label="Close">
        &#x2715;
      </button>
    </div>
  );
}

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
          <EncryptionInfoPopover onClose={() => setOpen(false)} />
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
      <EncryptionInfoPopover onClose={() => {}} />
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <LockIcon size={12} />
        <span
          style={{
            fontSize: "var(--poka-text-2xs)",
          }}
        >
          12px
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <LockIcon size={16} />
        <span
          style={{
            fontSize: "var(--poka-text-2xs)",
          }}
        >
          16px (default)
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <LockIcon size={24} />
        <span
          style={{
            fontSize: "var(--poka-text-2xs)",
          }}
        >
          24px
        </span>
      </div>
    </div>
  ),
};
