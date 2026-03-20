/**
 * CommentSidebar stories — organized by user journey.
 *
 * Mock data uses realistic names, content, and
 * timestamps. All authors appear as verified with
 * display names (no pubkey hex or badges visible).
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { Comment } from "@pokapali/comments";
import type { CommentData } from "./use-comments.js";
import { CommentSidebar } from "./comment-sidebar.js";

// ── Mock helpers ────────────────────────────────

const ALICE_KEY = "a".repeat(64);
const BOB_KEY = "b".repeat(64);
const CAROL_KEY = "c".repeat(64);
const DAVE_KEY = "d".repeat(64);

const displayNames = new Map([
  [ALICE_KEY, "Alice Chen"],
  [BOB_KEY, "Bob"],
  [CAROL_KEY, "Carol"],
  [DAVE_KEY, "Dave"],
]);

const now = Date.now();
const AGO_JUST_NOW = now - 3_000;
const AGO_5M = now - 5 * 60_000;
const AGO_20M = now - 20 * 60_000;
const AGO_2H = now - 2 * 3_600_000;
const AGO_1D = now - 24 * 3_600_000;

let nextId = 1;
function makeComment(
  overrides: Partial<Comment<CommentData>> & {
    author?: string;
    content?: string;
  } = {},
): Comment<CommentData> {
  const id = overrides.id ?? `c${nextId++}`;
  return {
    id,
    author: overrides.author ?? ALICE_KEY,
    authorVerified: true,
    content: overrides.content ?? "Looks good to me.",
    ts: overrides.ts ?? AGO_5M,
    anchor: overrides.anchor ?? {
      status: "resolved" as const,
      start: 10,
      end: 30,
    },
    parentId: overrides.parentId ?? null,
    children: overrides.children ?? [],
    data: overrides.data ?? { status: "open" },
  };
}

// ── Shared props ────────────────────────────────

const noop = () => {};

const baseProps = {
  editorView: null,
  myPubkey: ALICE_KEY,
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
  anchorPositions: new Map<string, number>(),
};

// ── Meta ────────────────────────────────────────

const meta: Meta<typeof CommentSidebar> = {
  component: CommentSidebar,
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: 380,
          height: 600,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CommentSidebar>;

// ── Reviewing ───────────────────────────────────

export const EmptyDocument: Story = {
  name: "Comments/Reviewing/Empty Document",
  args: {
    ...baseProps,
    comments: [],
  },
};

export const SingleComment: Story = {
  name: "Comments/Reviewing/Single Comment",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        author: ALICE_KEY,
        content:
          "Can we rephrase this paragraph? The current " +
          "wording is a bit confusing.",
        ts: AGO_2H,
      }),
    ],
  },
};

export const ActiveConversation: Story = {
  name: "Comments/Reviewing/Active Conversation",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        id: "active-1",
        author: BOB_KEY,
        content: "This contradicts what we said in section 2.",
        ts: AGO_1D,
        anchor: { status: "resolved", start: 5, end: 25 },
      }),
      makeComment({
        id: "active-2",
        author: ALICE_KEY,
        content: "+1, but maybe add an example here.",
        ts: AGO_2H,
        anchor: {
          status: "resolved",
          start: 80,
          end: 120,
        },
      }),
      makeComment({
        id: "active-3",
        author: CAROL_KEY,
        content: "Looks good to me.",
        ts: AGO_20M,
        anchor: {
          status: "resolved",
          start: 150,
          end: 170,
        },
      }),
      makeComment({
        id: "active-4",
        author: DAVE_KEY,
        content: "Should we mention the deadline here?",
        ts: AGO_5M,
        anchor: {
          status: "resolved",
          start: 200,
          end: 230,
        },
      }),
      makeComment({
        id: "active-5",
        author: BOB_KEY,
        content: "I updated the intro — let me know what " + "you think.",
        ts: AGO_JUST_NOW,
        anchor: {
          status: "resolved",
          start: 250,
          end: 280,
        },
      }),
    ],
    selectedId: "active-3",
  },
};

export const ThreadedDiscussion: Story = {
  name: "Comments/Reviewing/Threaded Discussion",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        author: BOB_KEY,
        content:
          "Can we rephrase this paragraph? The current " +
          "wording is a bit confusing.",
        ts: AGO_1D,
        children: [
          makeComment({
            author: ALICE_KEY,
            content:
              'Agreed — how about: "The system ' +
              "processes requests in order of " +
              'priority"?',
            ts: AGO_2H,
            parentId: "parent",
          }),
          makeComment({
            author: CAROL_KEY,
            content: "That reads much better, thanks!",
            ts: AGO_20M,
            parentId: "parent",
          }),
        ],
      }),
    ],
  },
};

export const ResolvedAndOpen: Story = {
  name: "Comments/Reviewing/Resolved and Open",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        author: ALICE_KEY,
        content: "We should add a summary at the top.",
        ts: AGO_1D,
        anchor: { status: "resolved", start: 5, end: 20 },
      }),
      makeComment({
        author: BOB_KEY,
        content: "This section needs more detail about " + "the timeline.",
        ts: AGO_2H,
        anchor: {
          status: "resolved",
          start: 100,
          end: 130,
        },
      }),
      makeComment({
        author: CAROL_KEY,
        content: "Fixed the typo in the title.",
        ts: AGO_1D,
        data: { status: "resolved" },
        anchor: {
          status: "resolved",
          start: 50,
          end: 65,
        },
      }),
      makeComment({
        author: DAVE_KEY,
        content: "Updated the budget numbers — addressed " + "in revision 3.",
        ts: AGO_1D,
        data: { status: "resolved" },
        anchor: {
          status: "resolved",
          start: 160,
          end: 190,
        },
      }),
    ],
  },
};

// ── Edge Cases ──────────────────────────────────

export const OverlappingComments: Story = {
  name: "Comments/Edge Cases/Many Overlapping",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        author: ALICE_KEY,
        content: "Needs rewording.",
        ts: AGO_1D,
        anchor: { status: "resolved", start: 10, end: 20 },
      }),
      makeComment({
        author: BOB_KEY,
        content: "Typo here.",
        ts: AGO_2H,
        anchor: { status: "resolved", start: 12, end: 18 },
      }),
      makeComment({
        author: CAROL_KEY,
        content: "Unclear phrasing.",
        ts: AGO_20M,
        anchor: { status: "resolved", start: 15, end: 25 },
      }),
      makeComment({
        author: DAVE_KEY,
        content: "Can we simplify this?",
        ts: AGO_5M,
        anchor: { status: "resolved", start: 8, end: 22 },
      }),
      makeComment({
        author: ALICE_KEY,
        content: "See my earlier comment above.",
        ts: AGO_JUST_NOW,
        anchor: { status: "resolved", start: 11, end: 19 },
      }),
    ],
    anchorPositions: new Map([
      ["c1", 10],
      ["c2", 12],
      ["c3", 15],
      ["c4", 8],
      ["c5", 11],
    ]),
  },
};

// Reset ID counter for predictable IDs
// (use explicit IDs in Overlapping above)

export const OrphanedComment: Story = {
  name: "Comments/Edge Cases/Deleted Text",
  args: {
    ...baseProps,
    comments: [
      makeComment({
        author: BOB_KEY,
        content:
          "This paragraph had important context " + "about the deadline.",
        ts: AGO_1D,
        anchor: { status: "orphaned" },
      }),
      makeComment({
        author: ALICE_KEY,
        content: "The intro looks great now.",
        ts: AGO_5M,
        anchor: {
          status: "resolved",
          start: 30,
          end: 60,
        },
      }),
    ],
  },
};

export const OfflineWarning: Story = {
  name: "Comments/Edge Cases/Offline",
  args: {
    ...baseProps,
    status: "offline",
    comments: [
      makeComment({
        author: ALICE_KEY,
        content: "Let me know when you've reviewed the " + "latest changes.",
        ts: AGO_2H,
      }),
      makeComment({
        author: BOB_KEY,
        content: "Will do — checking now.",
        ts: AGO_20M,
      }),
    ],
  },
};

export const AnonymousAuthors: Story = {
  name: "Comments/Edge Cases/Anonymous Authors",
  args: {
    ...baseProps,
    displayNames: new Map<string, string>(),
    labels: {
      formatAuthor: () => "Anonymous",
    },
    comments: [
      makeComment({
        author: ALICE_KEY,
        content: "Has anyone checked the formatting on " + "mobile?",
        ts: AGO_2H,
      }),
      makeComment({
        author: BOB_KEY,
        content: "Not yet — I can test this afternoon.",
        ts: AGO_20M,
      }),
      makeComment({
        author: CAROL_KEY,
        content: "The table in section 3 overflows on " + "smaller screens.",
        ts: AGO_5M,
      }),
    ],
  },
};
