/**
 * useComments hook stories — shown via a display
 * decorator that renders comment state as a simple
 * list.
 *
 * These demonstrate the hook's reactive behavior:
 * loading, populated, and optimistic add states.
 */

import { useState, useCallback } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import type { Comment } from "@pokapali/comments";
import type { CommentData } from "./use-comments.js";

// ── Types ───────────────────────────────────────

interface HookDisplayProps {
  comments: Comment<CommentData>[];
  loading?: boolean;
  onAdd?: () => void;
  addingComment?: string | null;
}

// ── Display component ───────────────────────────

function HookDisplay({
  comments,
  loading,
  onAdd,
  addingComment,
}: HookDisplayProps) {
  const displayNames = new Map([
    ["a".repeat(64), "Alice Chen"],
    ["b".repeat(64), "Bob"],
    ["c".repeat(64), "Carol"],
  ]);

  return (
    <div
      style={{
        padding: "1.5rem",
        fontFamily: "sans-serif",
        maxWidth: 480,
      }}
    >
      <h3
        style={{
          margin: "0 0 1rem",
          fontSize: "0.9rem",
        }}
      >
        useComments() →{" "}
        {loading ? "loading..." : `${comments.length} comment(s)`}
      </h3>

      {loading && (
        <div
          style={{
            color: "#94a3b8",
            fontStyle: "italic",
            padding: "2rem 0",
            textAlign: "center",
          }}
        >
          Connecting to document...
        </div>
      )}

      {!loading && comments.length === 0 && (
        <div
          style={{
            color: "#94a3b8",
            padding: "2rem 0",
            textAlign: "center",
          }}
        >
          No comments yet.
        </div>
      )}

      {comments.map((c) => (
        <div
          key={c.id}
          style={{
            padding: "0.6rem 0.8rem",
            marginBottom: "0.4rem",
            border: "1px solid #e2e8f0",
            borderRadius: 4,
            fontSize: "0.82rem",
            opacity: c.data.status === "resolved" ? 0.6 : 1,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              marginBottom: "0.2rem",
            }}
          >
            <strong>{displayNames.get(c.author) ?? "Anonymous"}</strong>
            <span style={{ color: "#94a3b8" }}>{c.data.status}</span>
          </div>
          <div>{c.content}</div>
        </div>
      ))}

      {addingComment && (
        <div
          style={{
            padding: "0.6rem 0.8rem",
            marginBottom: "0.4rem",
            border: "1px dashed #3b82f6",
            borderRadius: 4,
            fontSize: "0.82rem",
            color: "#3b82f6",
          }}
        >
          <strong>Adding:</strong> {addingComment}
        </div>
      )}

      {onAdd && !loading && (
        <button
          onClick={onAdd}
          style={{
            marginTop: "0.5rem",
            padding: "0.4rem 0.8rem",
            border: "1px solid #3b82f6",
            borderRadius: 4,
            background: "#3b82f6",
            color: "white",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          Add Comment
        </button>
      )}
    </div>
  );
}

// ── Mock data ───────────────────────────────────

const now = Date.now();

const populatedComments: Comment<CommentData>[] = [
  {
    id: "c1",
    author: "a".repeat(64),
    authorVerified: true,
    content:
      "Can we rephrase this paragraph? The current " + "wording is confusing.",
    ts: now - 24 * 3_600_000,
    anchor: { status: "resolved", start: 10, end: 40 },
    parentId: null,
    children: [],
    data: { status: "open" },
  },
  {
    id: "c2",
    author: "b".repeat(64),
    authorVerified: true,
    content: "Looks good to me.",
    ts: now - 2 * 3_600_000,
    anchor: { status: "resolved", start: 80, end: 100 },
    parentId: null,
    children: [],
    data: { status: "open" },
  },
  {
    id: "c3",
    author: "c".repeat(64),
    authorVerified: true,
    content: "Fixed the typo in the title.",
    ts: now - 3_600_000,
    anchor: { status: "resolved", start: 5, end: 15 },
    parentId: null,
    children: [],
    data: { status: "resolved" },
  },
];

// ── Meta ────────────────────────────────────────

const meta: Meta<typeof HookDisplay> = {
  title: "Comments/Data/useComments",
  component: HookDisplay,
};

export default meta;
type Story = StoryObj<typeof HookDisplay>;

// ── Stories ─────────────────────────────────────

export const Loading: Story = {
  name: "Loading",
  args: {
    comments: [],
    loading: true,
  },
};

export const CommentsLoaded: Story = {
  name: "Comments Loaded",
  args: {
    comments: populatedComments,
    loading: false,
  },
};

export const AddingComment: Story = {
  name: "Adding Comment",
  render: () => {
    const [comments, setComments] = useState(populatedComments);
    const [adding, setAdding] = useState<string | null>(null);

    const handleAdd = useCallback(() => {
      const content =
        "This section needs a diagram to " + "illustrate the workflow.";
      setAdding(content);

      // Simulate optimistic add
      setTimeout(() => {
        setComments((prev) => [
          ...prev,
          {
            id: `c${prev.length + 1}`,
            author: "a".repeat(64),
            authorVerified: true,
            content,
            ts: Date.now(),
            anchor: {
              status: "resolved" as const,
              start: 120,
              end: 150,
            },
            parentId: null,
            children: [],
            data: { status: "open" as const },
          },
        ]);
        setAdding(null);
      }, 800);
    }, []);

    return (
      <HookDisplay
        comments={comments}
        onAdd={handleAdd}
        addingComment={adding}
      />
    );
  },
};
