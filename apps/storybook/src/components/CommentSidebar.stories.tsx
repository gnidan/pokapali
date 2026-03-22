import type { Meta, StoryObj } from "@storybook/react";
import { CommentSidebar } from "@pokapali/react";
import type { Comment } from "@pokapali/comments";
import type { CommentData } from "@pokapali/react";

const noop = () => {};

const NOW = Date.now();
const HOUR = 3_600_000;
const MY_KEY = "abc123def456";
const OTHER_KEY = "xyz789ghi012";

function mockComment(
  overrides: Partial<Comment<CommentData>> & {
    id: string;
    content: string;
  },
): Comment<CommentData> {
  return {
    author: OTHER_KEY,
    authorVerified: true,
    ts: NOW - 2 * HOUR,
    anchor: { status: "resolved", start: 10, end: 25 },
    parentId: null,
    children: [],
    data: { status: "open" },
    ...overrides,
  };
}

const threadedComments: Comment<CommentData>[] = [
  mockComment({
    id: "c1",
    content:
      "This paragraph needs a citation. Can we add a " +
      "reference to the original paper?",
    ts: NOW - 4 * HOUR,
    children: [
      mockComment({
        id: "c1r1",
        author: MY_KEY,
        content: "Good catch — I'll add one in the next edit.",
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
    anchor: { status: "resolved", start: 80, end: 120 },
  }),
];

const resolvedComments: Comment<CommentData>[] = [
  mockComment({
    id: "c3",
    content: "Typo in line 3 — 'teh' should be 'the'.",
    ts: NOW - 8 * HOUR,
    data: { status: "resolved" },
    anchor: { status: "orphaned" },
  }),
];

const orphanedComment: Comment<CommentData>[] = [
  mockComment({
    id: "c4",
    content: "This comment's anchor text was deleted.",
    anchor: { status: "orphaned" },
  }),
];

const anchorPositions = new Map([
  ["c1", 10],
  ["c2", 80],
]);

const displayNames = new Map([
  [OTHER_KEY, "Alice"],
  [MY_KEY, "You"],
]);

function CommentSidebarStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2.5rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>CommentSidebar</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Threaded comment list ordered by document position. Supports replies,
        resolve/reopen, delete, and sync status warnings.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "2rem",
        }}
      >
        <div>
          <h3
            style={{
              fontSize: "var(--poka-text-sm)",
              color: "var(--poka-text-secondary)",
              marginBottom: "0.5rem",
            }}
          >
            With threads
          </h3>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={threadedComments}
              anchorPositions={anchorPositions}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="synced"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
              displayNames={displayNames}
            />
          </div>
        </div>

        <div>
          <h3
            style={{
              fontSize: "var(--poka-text-sm)",
              color: "var(--poka-text-secondary)",
              marginBottom: "0.5rem",
            }}
          >
            Empty state
          </h3>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={[]}
              anchorPositions={new Map()}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="synced"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
            />
          </div>
        </div>
      </div>

      <h3
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        Sync warnings
      </h3>
      <div
        style={{
          display: "flex",
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
            status=&quot;offline&quot;
          </code>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={threadedComments}
              anchorPositions={anchorPositions}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="offline"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
              displayNames={displayNames}
            />
          </div>
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
            status=&quot;connecting&quot;
          </code>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={threadedComments}
              anchorPositions={anchorPositions}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="connecting"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
              displayNames={displayNames}
            />
          </div>
        </div>
      </div>

      <h3
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        Resolved + Orphaned
      </h3>
      <div
        style={{
          display: "flex",
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
            Resolved comment (collapsed toggle)
          </code>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={resolvedComments}
              anchorPositions={new Map()}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="synced"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
              displayNames={displayNames}
            />
          </div>
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
            Orphaned anchor
          </code>
          <div
            style={{
              width: 320,
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              overflow: "hidden",
            }}
          >
            <CommentSidebar
              comments={orphanedComment}
              anchorPositions={new Map()}
              editorView={null}
              myPubkey={MY_KEY}
              hasPendingAnchor={false}
              status="synced"
              onAddComment={noop}
              onAddReply={noop}
              onResolve={noop}
              onReopen={noop}
              onDelete={noop}
              onClose={noop}
              selectedId={null}
              onSelect={noop}
              displayNames={displayNames}
            />
          </div>
        </div>
      </div>

      <h3
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        Pending anchor (new comment input)
      </h3>
      <div
        style={{
          width: 320,
          border: "1px solid var(--poka-border-default)",
          borderRadius: "var(--poka-radius-lg)",
          overflow: "hidden",
        }}
      >
        <CommentSidebar
          comments={threadedComments}
          anchorPositions={anchorPositions}
          editorView={null}
          myPubkey={MY_KEY}
          hasPendingAnchor={true}
          status="synced"
          onAddComment={noop}
          onAddReply={noop}
          onResolve={noop}
          onReopen={noop}
          onDelete={noop}
          onClose={noop}
          selectedId={null}
          onSelect={noop}
          displayNames={displayNames}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof CommentSidebarStories> = {
  title: "Components/CommentSidebar",
  component: CommentSidebarStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
