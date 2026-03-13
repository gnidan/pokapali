/**
 * Comment sidebar — threaded comment list with
 * add/reply/resolve/delete flows.
 *
 * Slides in from right (~350px), similar to
 * VersionHistory drawer.
 */

import { useState, useCallback, useRef } from "react";
import type { Comment } from "@pokapali/comments";
import type { CommentData } from "./useComments";

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

// ── Comment input ────────────────────────────────

function CommentInput({
  placeholder,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  onSubmit: (content: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  }, [text, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape" && onCancel) {
        onCancel();
      }
    },
    [handleSubmit, onCancel],
  );

  return (
    <div className="cs-comment-input">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
      />
      <div className="cs-comment-input-actions">
        {onCancel && (
          <button className="cs-btn cs-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          className="cs-btn cs-btn-submit"
          onClick={handleSubmit}
          disabled={!text.trim()}
        >
          Comment
        </button>
      </div>
    </div>
  );
}

// ── Single comment ───────────────────────────────

function CommentItem({
  comment,
  isReply,
  myPubkey,
  onReply,
  onResolve,
  onReopen,
  onDelete,
  onSelect,
  selected,
}: {
  comment: Comment<CommentData>;
  isReply: boolean;
  myPubkey: string | null;
  onReply: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  const isAuthor = myPubkey === comment.author;
  const isResolved = comment.data.status === "resolved";
  const hasOrphanedAnchor = comment.anchor?.status === "orphaned";

  return (
    <div
      className={
        "cs-comment" +
        (isReply ? " cs-reply" : "") +
        (selected ? " cs-selected" : "") +
        (isResolved ? " cs-resolved" : "") +
        (hasOrphanedAnchor ? " cs-orphaned" : "")
      }
      onClick={() => onSelect(comment.id)}
    >
      <div className="cs-comment-header">
        <span
          className={
            "cs-author" + (comment.authorVerified ? "" : " cs-unverified")
          }
          title={
            comment.authorVerified
              ? comment.author
              : `${comment.author} (unverified)`
          }
        >
          {truncatePubkey(comment.author)}
          {!comment.authorVerified && (
            <span className="cs-unverified-badge">?</span>
          )}
        </span>
        <span className="cs-timestamp">{relativeAge(comment.ts)}</span>
      </div>

      <div className="cs-comment-body">{comment.content}</div>

      {hasOrphanedAnchor && !isReply && (
        <div className="cs-orphan-note">Anchored text was deleted</div>
      )}

      <div className="cs-comment-actions">
        {!isReply && !isResolved && (
          <button
            className="cs-btn cs-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onReply(comment.id);
            }}
          >
            Reply
          </button>
        )}
        {!isReply && !isResolved && (
          <button
            className="cs-btn cs-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
          >
            Resolve
          </button>
        )}
        {!isReply && isResolved && (
          <button
            className="cs-btn cs-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(comment.id);
            }}
          >
            Reopen
          </button>
        )}
        {isAuthor && (
          <button
            className="cs-btn cs-btn-sm cs-btn-danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(comment.id);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ── Thread (top-level + replies) ─────────────────

function CommentThread({
  comment,
  myPubkey,
  replyingTo,
  onReply,
  onSubmitReply,
  onCancelReply,
  onResolve,
  onReopen,
  onDelete,
  onSelect,
  selectedId,
}: {
  comment: Comment<CommentData>;
  myPubkey: string | null;
  replyingTo: string | null;
  onReply: (id: string) => void;
  onSubmitReply: (parentId: string, content: string) => void;
  onCancelReply: () => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const isResolved = comment.data.status === "resolved";

  return (
    <div className={"cs-thread" + (isResolved ? " cs-thread-resolved" : "")}>
      <CommentItem
        comment={comment}
        isReply={false}
        myPubkey={myPubkey}
        onReply={onReply}
        onResolve={onResolve}
        onReopen={onReopen}
        onDelete={onDelete}
        onSelect={onSelect}
        selected={selectedId === comment.id}
      />

      {comment.children.map((reply) => (
        <CommentItem
          key={reply.id}
          comment={reply}
          isReply={true}
          myPubkey={myPubkey}
          onReply={onReply}
          onResolve={onResolve}
          onReopen={onReopen}
          onDelete={onDelete}
          onSelect={onSelect}
          selected={selectedId === reply.id}
        />
      ))}

      {replyingTo === comment.id && (
        <div className="cs-reply-input-wrap">
          <CommentInput
            placeholder="Write a reply…"
            onSubmit={(content) => onSubmitReply(comment.id, content)}
            onCancel={onCancelReply}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

// ── Main sidebar ─────────────────────────────────

export function CommentSidebar({
  comments,
  myPubkey,
  hasPendingAnchor,
  onAddComment,
  onAddReply,
  onResolve,
  onReopen,
  onDelete,
  onClose,
  selectedId,
  onSelect,
}: {
  comments: Comment<CommentData>[];
  myPubkey: string | null;
  /** True if a pending anchor is captured. */
  hasPendingAnchor: boolean;
  onAddComment: (content: string) => void;
  onAddReply: (parentId: string, content: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const openComments = comments.filter((c) => c.data.status === "open");
  const resolvedComments = comments.filter((c) => c.data.status === "resolved");

  const handleSubmitReply = useCallback(
    (parentId: string, content: string) => {
      onAddReply(parentId, content);
      setReplyingTo(null);
    },
    [onAddReply],
  );

  return (
    <div className="cs-sidebar" role="complementary" aria-label="Comments">
      <div className="cs-sidebar-header">
        <h3>Comments</h3>
        <button
          className="cs-sidebar-close"
          onClick={onClose}
          aria-label="Close comments"
        >
          &times;
        </button>
      </div>

      <div className="cs-sidebar-body">
        {hasPendingAnchor && myPubkey && (
          <div className="cs-new-comment">
            <CommentInput
              placeholder="Comment on selection…"
              onSubmit={onAddComment}
              autoFocus
            />
          </div>
        )}

        {!hasPendingAnchor && myPubkey && (
          <div className="cs-selection-hint">
            Select text and click 💬 to add a comment
          </div>
        )}

        {openComments.length === 0 && resolvedComments.length === 0 && (
          <div className="cs-empty">No comments yet.</div>
        )}

        {openComments.map((comment) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            myPubkey={myPubkey}
            replyingTo={replyingTo}
            onReply={setReplyingTo}
            onSubmitReply={handleSubmitReply}
            onCancelReply={() => setReplyingTo(null)}
            onResolve={onResolve}
            onReopen={onReopen}
            onDelete={onDelete}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        ))}

        {resolvedComments.length > 0 && (
          <>
            <button
              className="cs-resolved-toggle"
              onClick={() => setShowResolved((s) => !s)}
            >
              {showResolved ? "Hide" : "Show"} {resolvedComments.length}{" "}
              resolved
            </button>
            {showResolved &&
              resolvedComments.map((comment) => (
                <CommentThread
                  key={comment.id}
                  comment={comment}
                  myPubkey={myPubkey}
                  replyingTo={replyingTo}
                  onReply={setReplyingTo}
                  onSubmitReply={handleSubmitReply}
                  onCancelReply={() => setReplyingTo(null)}
                  onResolve={onResolve}
                  onReopen={onReopen}
                  onDelete={onDelete}
                  onSelect={onSelect}
                  selectedId={selectedId}
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}
