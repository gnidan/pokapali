/**
 * Shared comment mock data for Storybook stories.
 * Used by both CommentSidebar component story and
 * CommentsFlow pattern story.
 */

import type { Comment } from "@pokapali/comments";
import type { CommentData } from "@pokapali/react";

const NOW = Date.now();
const HOUR = 3_600_000;

export const MY_KEY = "abc123def456";
export const OTHER_KEY = "xyz789ghi012";

export function mockComment(
  overrides: Partial<Comment<CommentData>> & {
    id: string;
    content: string;
  },
): Comment<CommentData> {
  return {
    author: OTHER_KEY,
    authorVerified: true,
    ts: NOW - 2 * HOUR,
    anchor: {
      status: "resolved",
      start: 10,
      end: 25,
    },
    parentId: null,
    children: [],
    data: { status: "open" },
    ...overrides,
  };
}

export const threadedComments: Comment<CommentData>[] = [
  mockComment({
    id: "c1",
    content:
      "This paragraph needs a citation. Can we " +
      "add a reference to the original paper?",
    ts: NOW - 4 * HOUR,
    children: [
      mockComment({
        id: "c1r1",
        author: MY_KEY,
        content: "Good catch — I'll add one in the " + "next edit.",
        ts: NOW - 3 * HOUR,
        parentId: "c1",
        anchor: null,
      }),
      mockComment({
        id: "c1r2",
        content: "Thanks! No rush.",
        ts: NOW - 2 * HOUR,
        parentId: "c1",
        anchor: null,
      }),
    ],
  }),
  mockComment({
    id: "c2",
    author: MY_KEY,
    content: "Should we restructure this section?",
    ts: NOW - HOUR,
    anchor: {
      status: "resolved",
      start: 80,
      end: 120,
    },
  }),
];

export const resolvedComments: Comment<CommentData>[] = [
  mockComment({
    id: "c3",
    content: "Typo in line 3 — 'teh' should be 'the'.",
    ts: NOW - 8 * HOUR,
    data: { status: "resolved" },
    anchor: { status: "orphaned" },
  }),
];

export const orphanedComment: Comment<CommentData>[] = [
  mockComment({
    id: "c4",
    content: "This comment's anchor text was deleted.",
    anchor: { status: "orphaned" },
  }),
];

export const anchorPositions = new Map([
  ["c1", 10],
  ["c2", 80],
]);

export const displayNames = new Map([
  [OTHER_KEY, "Alice"],
  [MY_KEY, "You"],
]);

const noop = () => {};

export const baseCommentProps = {
  editorView: null,
  myPubkey: MY_KEY,
  hasPendingAnchor: false,
  status: "synced" as const,
  onAddComment: noop,
  onAddReply: noop,
  onResolve: noop,
  onReopen: noop,
  onDelete: noop,
  onClose: noop,
  selectedId: null,
  onSelect: noop,
  displayNames,
};

export function SidebarFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 320,
        border: "1px solid var(--poka-border-default)",
        borderRadius: "var(--poka-radius-lg)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}
