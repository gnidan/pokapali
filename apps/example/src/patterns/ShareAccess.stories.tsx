import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { Doc } from "@pokapali/core";
import { SharePanel } from "../SharePanel";
import { EncryptionInfo, LockIcon } from "../EncryptionInfo";

/**
 * Share & Access pattern — shows the share panel
 * alongside encryption info and role badges,
 * demonstrating the capability-URL sharing model
 * and how access tiers are communicated.
 */

const badgeColors: Record<string, { bg: string; fg: string }> = {
  admin: {
    bg: "var(--poka-surface-warning)",
    fg: "var(--poka-color-warning)",
  },
  writer: {
    bg: "var(--poka-surface-info)",
    fg: "var(--poka-color-accent)",
  },
  reader: {
    bg: "var(--poka-bg-subtle)",
    fg: "var(--poka-text-secondary)",
  },
};

function Badge({ role }: { role: "admin" | "writer" | "reader" }) {
  const { bg, fg } = badgeColors[role]!;
  return (
    <span
      style={{
        fontSize: "var(--poka-text-2xs)",
        fontWeight: "var(--poka-weight-medium)" as unknown as number,
        padding: "2px 8px",
        borderRadius: "var(--poka-radius-full)",
        background: bg,
        color: fg,
        textTransform: "capitalize",
      }}
    >
      {role}
    </span>
  );
}

const base = "https://app.pokapali.dev/#/doc/bafyreih5g7wxmq3a";

function mockDoc(role: "admin" | "writer" | "reader"): Doc {
  const urls: Record<string, string> = {
    read: base + "?cap=read_key_def456",
  };
  if (role === "admin" || role === "writer") {
    urls.write = base + "?cap=write_key_xyz789";
  }
  if (role === "admin") {
    urls.admin = base + "?cap=admin_key_abc123";
  }
  return { urls } as unknown as Doc;
}

function ShareAccessPattern() {
  const [encOpen, setEncOpen] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
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
              border: "1px solid var(--poka-color-accent)",
              background: "var(--poka-surface-info)",
              color: "var(--poka-color-accent)",
              cursor: "pointer",
            }}
          >
            Share
          </button>
        </div>

        {encOpen && (
          <div style={{ maxWidth: 320 }}>
            <EncryptionInfo onClose={() => setEncOpen(false)} />
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
          <SharePanel doc={mockDoc("admin")} />
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
          <SharePanel doc={mockDoc("reader")} />
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof ShareAccessPattern> = {
  title: "Patterns/Share & Access",
  component: ShareAccessPattern,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
