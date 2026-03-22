import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Inline SharePanel for Storybook — mirrors the
 * CopyRow + SharePanel markup from apps/example.
 * QR rendering omitted (requires @paulmillr/qr).
 */

function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  const truncated =
    value.length > 60
      ? value.slice(0, 30) + "\u2026" + value.slice(-20)
      : value;

  return (
    <div className="share-card">
      <div className="share-card-header">
        <span className="share-card-label">{label}</span>
        <span className="share-card-desc">{description}</span>
      </div>
      <div className="share-card-row">
        <input type="text" readOnly value={truncated} title={value} />
        <button
          className="copy-btn"
          onClick={() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
        <button className="qr-btn" aria-label="Show QR code">
          QR
        </button>
      </div>
    </div>
  );
}

function SharePanelDemo({ role }: { role: "admin" | "writer" | "reader" }) {
  const base = "https://app.pokapali.dev/#/doc/bafyreih5g7wxmq3a";

  return (
    <div className="share-panel" role="region" aria-label="Share panel">
      <h2>Share this document</h2>
      {role === "admin" && (
        <CopyRow
          label="Admin"
          description={
            "Full control \u2014 can edit, publish," + " and manage access"
          }
          value={base + "?cap=admin_key_abc123"}
        />
      )}
      {(role === "admin" || role === "writer") && (
        <CopyRow
          label="Write"
          description={"Can edit the document and publish" + " snapshots"}
          value={base + "?cap=write_key_xyz789"}
        />
      )}
      <CopyRow
        label="Read"
        description="View only — cannot make changes"
        value={base + "?cap=read_key_def456"}
      />
    </div>
  );
}

function SharePanelStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>SharePanel</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Card-based panel showing capability URLs for sharing. Admin sees all 3
        tiers, writer sees 2, reader sees 1. Each row has a copy button and QR
        toggle.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        <div>
          <code
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
              display: "block",
              marginBottom: "0.5rem",
            }}
          >
            Admin (3 tiers)
          </code>
          <SharePanelDemo role="admin" />
        </div>
        <div>
          <code
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
              display: "block",
              marginBottom: "0.5rem",
            }}
          >
            Writer (2 tiers)
          </code>
          <SharePanelDemo role="writer" />
        </div>
        <div>
          <code
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
              display: "block",
              marginBottom: "0.5rem",
            }}
          >
            Reader (1 tier)
          </code>
          <SharePanelDemo role="reader" />
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof SharePanelStories> = {
  title: "Components/SharePanel",
  component: SharePanelStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
