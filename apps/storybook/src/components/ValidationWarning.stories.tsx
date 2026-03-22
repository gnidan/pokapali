import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Inline ValidationWarning for Storybook — the real
 * component lives in apps/example and is not exported.
 * This mirrors its exact markup and CSS classes.
 */
function ValidationWarning({ cid, message }: { cid: string; message: string }) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const shortCid = cid.length > 16 ? cid.slice(0, 16) + "\u2026" : cid;

  return (
    <div
      className="validation-warning"
      role="status"
      aria-live="polite"
      title={`Rejected snapshot: ${cid}`}
    >
      <span className="validation-warning-text">{message}</span>
      <span className="validation-warning-cid" aria-hidden="true">
        {shortCid}
      </span>
      <button
        className="validation-warning-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss warning"
      >
        &times;
      </button>
    </div>
  );
}

function ValidationWarningStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>ValidationWarning</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Alert banner shown when a received update fails signature validation.
        Displays a truncated CID and a dismiss button. Uses warning surface
        tokens.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
          maxWidth: 600,
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
            Invalid signature — long CID (truncated)
          </code>
          <ValidationWarning
            cid="bafyreih5g7wxmq3a4k2vpe6e7lzqxbh4ndrs2oa3f5wkymjnqv7kzpxmy"
            message="A received update was rejected (invalid signature)"
          />
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
            Short CID (no truncation)
          </code>
          <ValidationWarning
            cid="bafyreih5g7wxm"
            message="A received update was rejected (invalid signature)"
          />
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof ValidationWarningStories> = {
  title: "Components/ValidationWarning",
  component: ValidationWarningStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
