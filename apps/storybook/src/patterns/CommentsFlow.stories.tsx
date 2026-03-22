import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Comments Flow pattern — shows the interaction
 * between the inline CommentPopover trigger, the
 * CommentSidebar drawer, and highlighted anchors
 * in mock editor content.
 */

const NOW = Date.now();
const MIN = 60_000;

interface MockComment {
  id: string;
  author: string;
  text: string;
  ts: number;
  resolved?: boolean;
  replies?: {
    author: string;
    text: string;
    ts: number;
  }[];
}

const displayNames: Record<string, string> = {
  alice: "Alice Chen",
  bob: "Bob Park",
  carol: "Carol Rivera",
};

const comments: MockComment[] = [
  {
    id: "c1",
    author: "alice",
    text: "Should we clarify the timeline here?",
    ts: NOW - 45 * MIN,
    replies: [
      {
        author: "bob",
        text: "Good call — I'll add specifics.",
        ts: NOW - 30 * MIN,
      },
    ],
  },
  {
    id: "c2",
    author: "carol",
    text: "This section needs a code example.",
    ts: NOW - 20 * MIN,
  },
  {
    id: "c3",
    author: "bob",
    text: "Resolved: moved to appendix.",
    ts: NOW - 2 * 60 * MIN,
    resolved: true,
  },
];

function CommentBubble({
  comment,
  selected,
  onSelect,
}: {
  comment: MockComment;
  selected: boolean;
  onSelect: () => void;
}) {
  const age = Math.round((NOW - comment.ts) / 1000 / 60);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

  return (
    <button
      className={
        "poka-comment" +
        (selected ? " selected" : "") +
        (comment.resolved ? " resolved" : "")
      }
      onClick={onSelect}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--poka-space-1)",
        padding: "var(--poka-space-2) var(--poka-space-3)",
        background: selected
          ? "var(--poka-surface-info)"
          : comment.resolved
            ? "var(--poka-bg-subtle)"
            : "var(--poka-bg-surface)",
        border: `1px solid ${
          selected ? "var(--poka-color-accent)" : "var(--poka-border-default)"
        }`,
        borderRadius: "var(--poka-radius-md)",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        opacity: comment.resolved ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--poka-space-2)",
          fontSize: "var(--poka-text-xs)",
        }}
      >
        <span
          style={{
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            color: "var(--poka-text-primary)",
          }}
        >
          {displayNames[comment.author] ?? comment.author}
        </span>
        <span style={{ color: "var(--poka-text-muted)" }}>{ageStr}</span>
        {comment.resolved && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
            }}
          >
            resolved
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-secondary)",
        }}
      >
        {comment.text}
      </div>
      {comment.replies?.map((r, i) => (
        <div
          key={i}
          style={{
            marginLeft: "var(--poka-space-3)",
            paddingLeft: "var(--poka-space-2)",
            borderLeft: "2px solid var(--poka-border-default)",
            fontSize: "var(--poka-text-xs)",
            color: "var(--poka-text-secondary)",
          }}
        >
          <span
            style={{
              fontWeight: "var(--poka-weight-medium)" as unknown as number,
              color: "var(--poka-text-primary)",
            }}
          >
            {displayNames[r.author] ?? r.author}
          </span>{" "}
          {r.text}
        </div>
      ))}
    </button>
  );
}

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
            border: "1px solid var(--poka-border-default)",
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
                borderBottom: "2px solid var(--poka-color-accent)",
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
                borderBottom: "2px solid var(--poka-color-accent)",
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
              borderTop: "1px dashed var(--poka-border-default)",
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

        {/* Comment sidebar */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            background: "var(--poka-bg-surface)",
            border: "1px solid var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--poka-space-3) " + "var(--poka-space-3)",
              borderBottom: "1px solid " + "var(--poka-border-default)",
            }}
          >
            <span
              style={{
                fontSize: "var(--poka-text-sm)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
              }}
            >
              Comments ({comments.length})
            </span>
            <button
              style={{
                background: "none",
                border: "none",
                fontSize: "var(--poka-text-sm)",
                color: "var(--poka-text-muted)",
                cursor: "pointer",
              }}
            >
              &#x2715;
            </button>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--poka-space-2)",
              padding: "var(--poka-space-2)",
              maxHeight: 400,
              overflow: "auto",
            }}
          >
            {comments.map((c) => (
              <CommentBubble
                key={c.id}
                comment={c}
                selected={selectedId === c.id}
                onSelect={() =>
                  setSelectedId(selectedId === c.id ? null : c.id)
                }
              />
            ))}
          </div>
        </div>
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
