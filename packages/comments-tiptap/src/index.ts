/**
 * @pokapali/comments-tiptap — thin adapter bridging
 * @pokapali/comments with Tiptap/ProseMirror editors.
 *
 * Provides comment anchor highlighting, pending anchor
 * highlighting, and position-bridging helpers.
 */

// ── Anchor bridge ────────────────────────────────
export {
  anchorFromSelection,
  getSyncState,
  type SyncState,
} from "./anchor-bridge.js";

// ── Bulk resolution ──────────────────────────────
export { resolveAnchors, type ResolvedCommentAnchor } from "./resolve.js";

// ── Extensions ───────────────────────────────────
export {
  CommentHighlight,
  commentHighlightKey,
  rebuildCommentDecorations,
  type CommentHighlightOptions,
} from "./comment-highlight.js";

export {
  PendingAnchorHighlight,
  setPendingAnchorDecoration,
  clearPendingAnchorDecoration,
} from "./pending-highlight.js";

// ── Re-exports from @pokapali/comments ───────────
export type { Anchor } from "@pokapali/comments";
