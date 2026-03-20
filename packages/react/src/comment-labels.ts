/**
 * Label interfaces for comment component i18n.
 *
 * Each component accepts an optional `labels` prop.
 * All fields have English defaults — consumers only
 * override what they need.
 */

import type { ReactNode } from "react";

// ── Sidebar labels ───────────────────────────────

export interface CommentSidebarLabels {
  /** Sidebar heading. Default: "Comments" */
  title?: string;
  /** Close button aria-label.
   *  Default: "Close comments" */
  closeAriaLabel?: string;
  /** Offline sync warning.
   *  Default: "Offline — comments won't sync" */
  offlineWarning?: string;
  /** Connecting sync warning.
   *  Default: "Connecting — comments may not sync
   *  yet" */
  connectingWarning?: string;
  /** New comment input placeholder.
   *  Default: "Comment on selection…" */
  commentPlaceholder?: string;
  /** Reply input placeholder.
   *  Default: "Write a reply…" */
  replyPlaceholder?: string;
  /** Hint when no anchor is selected.
   *  Default: "Select text and click 💬 to add a
   *  comment" */
  selectionHint?: string;
  /** Empty state. Default: "No comments yet." */
  emptyState?: string;
  /** Orphaned anchor note.
   *  Default: "Anchored text was deleted" */
  orphanedNote?: string;
  /** Submit button. Default: "Comment" */
  submitButton?: string;
  /** Cancel button. Default: "Cancel" */
  cancelButton?: string;
  /** Reply button. Default: "Reply" */
  replyButton?: string;
  /** Resolve button. Default: "Resolve" */
  resolveButton?: string;
  /** Reopen button. Default: "Reopen" */
  reopenButton?: string;
  /** Delete button. Default: "Delete" */
  deleteButton?: string;
  /** Resolved toggle template. Receives count and
   *  shown state. */
  resolvedToggle?: (count: number, shown: boolean) => string;
  /** Relative age formatter. Receives timestamp. */
  formatAge?: (ts: number) => string;
  /** Author display formatter. Receives full pubkey
   *  hex and optional display name. */
  formatAuthor?: (pubkey: string, displayName?: string) => string;
}

// ── Popover labels ───────────────────────────────

export interface CommentPopoverLabels {
  /** Button aria-label.
   *  Default: "Add comment" */
  addCommentAriaLabel?: string;
  /** Button title tooltip.
   *  Default: "Add comment" */
  addCommentTitle?: string;
  /** Button content.
   *  Default: "💬" */
  addCommentIcon?: ReactNode;
}

// ── Helpers ──────────────────────────────────────

function relativeAge(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return pubkey.slice(0, 6) + "…" + pubkey.slice(-4);
}

// ── Defaults ─────────────────────────────────────

export const defaultSidebarLabels: Required<CommentSidebarLabels> = {
  title: "Comments",
  closeAriaLabel: "Close comments",
  offlineWarning: "Offline — comments won't sync",
  connectingWarning: "Connecting — comments may not sync yet",
  commentPlaceholder: "Comment on selection…",
  replyPlaceholder: "Write a reply…",
  selectionHint: "Select text and click 💬 to add a comment",
  emptyState: "No comments yet.",
  orphanedNote: "Anchored text was deleted",
  submitButton: "Comment",
  cancelButton: "Cancel",
  replyButton: "Reply",
  resolveButton: "Resolve",
  reopenButton: "Reopen",
  deleteButton: "Delete",
  resolvedToggle: (count, shown) =>
    `${shown ? "Hide" : "Show"} ${count} resolved`,
  formatAge: relativeAge,
  formatAuthor: (pubkey, displayName) => displayName ?? truncatePubkey(pubkey),
};

export const defaultPopoverLabels: Required<CommentPopoverLabels> = {
  addCommentAriaLabel: "Add comment",
  addCommentTitle: "Add comment",
  addCommentIcon: "💬",
};

/**
 * Merge partial labels with defaults.
 */
export function resolveSidebarLabels(
  labels?: CommentSidebarLabels,
): Required<CommentSidebarLabels> {
  if (!labels) return defaultSidebarLabels;
  return { ...defaultSidebarLabels, ...labels };
}

export function resolvePopoverLabels(
  labels?: CommentPopoverLabels,
): Required<CommentPopoverLabels> {
  if (!labels) return defaultPopoverLabels;
  return { ...defaultPopoverLabels, ...labels };
}
