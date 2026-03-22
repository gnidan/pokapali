import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Inline LockIcon + EncryptionInfo for Storybook —
 * the real components live in apps/example.
 */
function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function EncryptionInfoPopover({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="encryption-popover"
      role="dialog"
      aria-modal="true"
      aria-label="Encryption information"
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

function EncryptionInfoStories() {
  const [open, setOpen] = useState(true);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>EncryptionInfo</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Modal popover explaining end-to-end encryption. Triggered by the lock
        icon in the header. Supports Escape to close, click-outside, and focus
        trapping.
      </p>

      <div>
        <h3
          style={{
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-secondary)",
            marginBottom: "0.5rem",
          }}
        >
          Trigger + Popover
        </h3>
        <div
          style={{
            position: "relative",
            display: "inline-block",
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
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                zIndex: 10,
                marginTop: 4,
              }}
            >
              <EncryptionInfoPopover onClose={() => setOpen(false)} />
            </div>
          )}
        </div>
      </div>

      <div>
        <h3
          style={{
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-secondary)",
            marginBottom: "0.5rem",
          }}
        >
          Popover (static)
        </h3>
        <div style={{ maxWidth: 340 }}>
          <EncryptionInfoPopover onClose={() => {}} />
        </div>
      </div>

      <div>
        <h3
          style={{
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-secondary)",
            marginBottom: "0.5rem",
          }}
        >
          Lock Icon sizes
        </h3>
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
      </div>
    </div>
  );
}

const meta: Meta<typeof EncryptionInfoStories> = {
  title: "Components/EncryptionInfo",
  component: EncryptionInfoStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
