import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Badge, CopyRow, LockIcon } from "../helpers/story-helpers";

/**
 * Share & Access pattern — shows the share panel
 * alongside encryption info and role badges,
 * demonstrating the capability-URL sharing model
 * and how access tiers are communicated.
 */

const baseUrl = "https://app.pokapali.dev/#/doc/bafyreih5g7wxmq3a";

function ShareAccessPatterns() {
  const [encOpen, setEncOpen] = useState(false);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Share &amp; Access</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Sharing pattern combining the share panel, encryption indicator, and
        role badges. The capability-URL model means each access tier has its own
        link. The encryption popover reassures users about E2E security.
      </p>

      {/* Header context */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--poka-space-2)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--poka-space-3)",
            padding: "var(--poka-space-3) " + "var(--poka-space-4)",
            background: "var(--poka-bg-surface)",
            border: "1px solid var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
          }}
        >
          <span
            style={{
              fontSize: "var(--poka-text-base)",
              fontWeight: "var(--poka-weight-semibold)" as unknown as number,
              color: "var(--poka-text-primary)",
            }}
          >
            Project Roadmap
          </span>
          <Badge role="admin" />

          {/* Encryption toggle */}
          <button
            onClick={() => setEncOpen((s) => !s)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
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

          <span style={{ marginLeft: "auto" }} />

          <button
            style={{
              fontSize: "var(--poka-text-xs)",
              fontWeight: "var(--poka-weight-medium)" as unknown as number,
              padding: "4px 10px",
              borderRadius: "var(--poka-radius-md)",
              border: "1px solid " + "var(--poka-color-accent)",
              background: "var(--poka-surface-info)",
              color: "var(--poka-color-accent)",
              cursor: "pointer",
            }}
          >
            Share
          </button>
        </div>

        {/* Encryption popover — in flow */}
        {encOpen && (
          <div
            style={{
              width: 280,
              padding: "var(--poka-space-3)",
              background: "var(--poka-bg-surface)",
              border: "1px solid " + "var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
              fontSize: "var(--poka-text-xs)",
              color: "var(--poka-text-secondary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--poka-space-1)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
                marginBottom: "var(--poka-space-2)",
              }}
            >
              <LockIcon size={14} />
              End-to-end encrypted
            </div>
            <p
              style={{
                marginBottom: "var(--poka-space-1)",
              }}
            >
              Relay and pinner nodes cannot read your content &mdash; they only
              store encrypted blocks.
            </p>
            <p>
              Only people with the document link can read it. Your link
              determines your access level.
            </p>
          </div>
        )}
      </div>

      {/* Share panels for each role */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--poka-space-4)",
          alignItems: "start",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-2)",
              marginBottom: "var(--poka-space-2)",
            }}
          >
            <Badge role="admin" />
            <span
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
              }}
            >
              sees all 3 tiers
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--poka-space-2)",
              padding: "var(--poka-space-3)",
              background: "var(--poka-bg-surface)",
              border: "1px solid " + "var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
            }}
          >
            <CopyRow
              label="Admin"
              description="Full control"
              value={baseUrl + "?cap=admin_key_abc123"}
            />
            <CopyRow
              label="Write"
              description="Can edit and publish"
              value={baseUrl + "?cap=write_key_xyz789"}
            />
            <CopyRow
              label="Read"
              description="View only"
              value={baseUrl + "?cap=read_key_def456"}
            />
          </div>
        </div>

        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--poka-space-2)",
              marginBottom: "var(--poka-space-2)",
            }}
          >
            <Badge role="reader" />
            <span
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
              }}
            >
              sees read tier only
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--poka-space-2)",
              padding: "var(--poka-space-3)",
              background: "var(--poka-bg-surface)",
              border: "1px solid " + "var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
            }}
          >
            <CopyRow
              label="Read"
              description="View only"
              value={baseUrl + "?cap=read_key_def456"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof ShareAccessPatterns> = {
  title: "Patterns/Share & Access",
  component: ShareAccessPatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
