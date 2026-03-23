/**
 * Header / Status Line pattern — imports real
 * StatusIndicator, SaveIndicator, and LastUpdated
 * components from the example app (hook-based).
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { DocStatus, SaveState } from "@pokapali/core";
import { StatusIndicator } from "../StatusIndicator";
import { SaveIndicator, LastUpdated } from "../SaveIndicator";

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
      className={active ? "toggle-comments" : "toggle-share"}
      style={active ? { borderColor: "var(--poka-color-accent)" } : {}}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="comment-count-badge">{badge}</span>
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
    <div className="header">
      <div className="header-identity">
        <button className="back-arrow">&#8592;</button>
        <h1>
          Pokapali<span className="app-subtitle">Demo editor</span>
        </h1>
        <button className="doc-title">{title}</button>
        <span className={"badge " + role}>{role}</span>
      </div>
      <div className="header-toolbar">
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
    <div className="app">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2rem",
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
            Reader — synced, LastUpdated instead of SaveIndicator
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
            Admin — offline, save error, comments open
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
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
