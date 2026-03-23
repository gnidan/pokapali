import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { CommentSidebar } from "@pokapali/react";
import {
  threadedComments,
  anchorPositions,
  baseCommentProps,
  SidebarFrame,
} from "../mock-comment-data";

/**
 * Comments Flow pattern — shows the interaction
 * between the inline CommentPopover trigger, the
 * CommentSidebar drawer, and highlighted anchors
 * in mock editor content.
 */

function CommentsFlowPatterns() {
  const [selectedId, setSelectedId] = useState<string | null>("c1");

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Comments Flow</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Editor + sidebar interaction pattern. Selecting text shows a popover to
        start a comment; the sidebar lists all threads with anchored highlights.
        Clicking a comment highlights its anchor in the editor.
      </p>

      <div
        style={{
          display: "flex",
          gap: "var(--poka-space-4)",
          alignItems: "start",
        }}
      >
        {/* Mock editor */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--poka-bg-surface)",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            padding: "var(--poka-space-4)",
            fontSize: "var(--poka-text-sm)",
            lineHeight: 1.6,
            color: "var(--poka-text-primary)",
          }}
        >
          <p style={{ marginBottom: "1em" }}>
            The project roadmap outlines three phases of development.{" "}
            <span
              style={{
                background:
                  selectedId === "c1"
                    ? "rgba(37, 99, 235, 0.15)"
                    : "rgba(37, 99, 235, 0.08)",
                borderBottom: "2px solid " + "var(--poka-color-accent)",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onClick={() => setSelectedId("c1")}
            >
              Phase 1 targets Q2 delivery with initial integration complete by
              end of March.
            </span>
          </p>
          <p style={{ marginBottom: "1em" }}>
            Each phase builds on the previous, ensuring backward compatibility
            with existing clients.{" "}
            <span
              style={{
                background:
                  selectedId === "c2"
                    ? "rgba(37, 99, 235, 0.15)"
                    : "rgba(37, 99, 235, 0.08)",
                borderBottom: "2px solid " + "var(--poka-color-accent)",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onClick={() => setSelectedId("c2")}
            >
              The migration process is handled automatically.
            </span>
          </p>
          <p>Final validation occurs during the staging rollout period.</p>

          {/* Popover trigger mock */}
          <div
            style={{
              marginTop: "var(--poka-space-4)",
              paddingTop: "var(--poka-space-3)",
              borderTop: "1px dashed " + "var(--poka-border-default)",
            }}
          >
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "var(--poka-space-2)",
              }}
            >
              CommentPopover (appears on selection)
            </code>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--poka-space-1)",
                padding: "4px 10px",
                background: "var(--poka-bg-surface)",
                border: "1px solid " + "var(--poka-border-default)",
                borderRadius: "var(--poka-radius-md)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                fontSize: "var(--poka-text-xs)",
                color: "var(--poka-text-secondary)",
                cursor: "pointer",
              }}
            >
              + Comment
            </div>
          </div>
        </div>

        {/* Comment sidebar — real component */}
        <SidebarFrame>
          <CommentSidebar
            {...baseCommentProps}
            comments={threadedComments}
            anchorPositions={anchorPositions}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(selectedId === id ? null : id)}
          />
        </SidebarFrame>
      </div>
    </div>
  );
}

const meta: Meta<typeof CommentsFlowPatterns> = {
  title: "Patterns/Comments Flow",
  component: CommentsFlowPatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
