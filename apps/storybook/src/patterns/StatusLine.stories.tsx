import type { Meta, StoryObj } from "@storybook/react";
import { StatusIndicator, SaveIndicator, LastUpdated } from "@pokapali/react";
import type { DocStatus } from "@pokapali/core";
import type { SaveState } from "@pokapali/core";
import { Badge } from "../helpers/story-helpers";

const noop = () => {};

function ToolbarButton({
  label,
  active,
  badge,
}: {
  label: string;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      style={{
        fontSize: "var(--poka-text-xs)",
        fontWeight: "var(--poka-weight-medium)" as unknown as number,
        padding: "4px 10px",
        borderRadius: "var(--poka-radius-md)",
        border: `1px solid ${active ? "var(--poka-color-accent)" : "var(--poka-border-default)"}`,
        background: active
          ? "var(--poka-surface-info)"
          : "var(--poka-bg-surface)",
        color: active
          ? "var(--poka-color-accent)"
          : "var(--poka-text-secondary)",
        cursor: "pointer",
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          style={{
            fontSize: "var(--poka-text-2xs)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            background: "var(--poka-color-accent)",
            color: "#ffffff",
            borderRadius: "var(--poka-radius-full)",
            padding: "1px 5px",
            minWidth: 16,
            textAlign: "center",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function HeaderRow({
  title,
  role,
  status,
  saveState,
  ackCount,
  commentsOpen,
  commentCount,
}: {
  title: string;
  role: "admin" | "writer" | "reader";
  status: DocStatus;
  saveState: SaveState;
  ackCount: number;
  commentsOpen?: boolean;
  commentCount?: number;
}) {
  const isReader = role === "reader";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--poka-space-2)",
        padding: "var(--poka-space-3) var(--poka-space-4)",
        background: "var(--poka-bg-surface)",
        border: "1px solid var(--poka-border-default)",
        borderRadius: "var(--poka-radius-lg)",
      }}
    >
      {/* Identity row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--poka-space-2)",
        }}
      >
        <span
          style={{
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-muted)",
            cursor: "pointer",
          }}
        >
          &#8592;
        </span>
        <span
          style={{
            fontSize: "var(--poka-text-lg)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            color: "var(--poka-text-primary)",
          }}
        >
          Pokapali
        </span>
        <span
          style={{
            fontSize: "var(--poka-text-base)",
            fontWeight: "var(--poka-weight-medium)" as unknown as number,
            color: "var(--poka-text-primary)",
          }}
        >
          {title}
        </span>
        <Badge role={role} />
      </div>

      {/* Toolbar row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--poka-space-3)",
        }}
      >
        <StatusIndicator status={status} />
        <span style={{ marginLeft: "auto" }} />
        {isReader ? (
          <LastUpdated timestamp={Date.now() - 120_000} flash={false} />
        ) : (
          <SaveIndicator
            saveState={saveState}
            ackCount={ackCount}
            onPublish={noop}
          />
        )}
        <ToolbarButton label="Share" />
        <ToolbarButton label="History" />
        <ToolbarButton
          label="Comments"
          active={commentsOpen}
          badge={commentCount}
        />
      </div>
    </div>
  );
}

function StatusLinePatterns() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Header / Status Line</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Two-row header pattern: identity row (back, title, role badge) and
        toolbar row (connection status, save state, action buttons).
        Demonstrates the three-concern separation: connectivity
        (StatusIndicator), persistence (SaveIndicator), and identity (badge +
        title).
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
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
            Admin — synced, saved with 2 acks, 3 comments
          </code>
          <HeaderRow
            title="Project Roadmap"
            role="admin"
            status="synced"
            saveState="saved"
            ackCount={2}
            commentCount={3}
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
            Writer — connecting, dirty (unsaved changes)
          </code>
          <HeaderRow
            title="Meeting Notes"
            role="writer"
            status="connecting"
            saveState="dirty"
            ackCount={0}
            commentCount={1}
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
            Reader — synced, shows LastUpdated instead of SaveIndicator
          </code>
          <HeaderRow
            title="Published Report"
            role="reader"
            status="synced"
            saveState="saved"
            ackCount={0}
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
            Admin — offline, save error, comments panel open
          </code>
          <HeaderRow
            title="Draft Spec"
            role="admin"
            status="offline"
            saveState="save-error"
            ackCount={0}
            commentsOpen={true}
            commentCount={7}
          />
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof StatusLinePatterns> = {
  title: "Patterns/Header Status Line",
  component: StatusLinePatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
