/**
 * Comment sidebar — threaded comment list ordered
 * by document position.
 *
 * Comments with anchors are sorted by their
 * ProseMirror position in the document. Unanchored
 * or orphaned comments appear at the end.
 *
 * When an editorView is available, cards are
 * spatially positioned to align with their anchor
 * text using coordsAtPos().
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { EditorView } from "@tiptap/pm/view";
import type { Comment } from "@pokapali/comments";
import type { DocStatus } from "@pokapali/core";
import type { CommentData } from "./use-comments.js";
import { spatialLayout, type LayoutItem } from "./spatial-layout.js";
import {
  resolveSidebarLabels,
  type CommentSidebarLabels,
} from "./comment-labels.js";

// ── Comment input ────────────────────────────────

function CommentInput({
  placeholder,
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  submitLabel: string;
  cancelLabel: string;
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
    <div className="pkp-comment-input">
      <textarea
        ref={ref}
        data-testid="comment-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
      />
      <div className="pkp-comment-input__actions">
        {onCancel && (
          <button className="pkp-btn pkp-btn--cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
        <button
          className="pkp-btn pkp-btn--submit"
          data-testid="comment-submit"
          onClick={handleSubmit}
          disabled={!text.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Single comment ───────────────────────────────

function CommentItemView({
  comment,
  isReply,
  myPubkey,
  onReply,
  onResolve,
  onReopen,
  onDelete,
  onSelect,
  selected,
  labels,
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
  labels: Required<CommentSidebarLabels>;
}) {
  const isAuthor = myPubkey === comment.author;
  const isResolved = comment.data.status === "resolved";
  const hasOrphanedAnchor = comment.anchor?.status === "orphaned";

  return (
    <div
      className={
        "pkp-comment" +
        (isReply ? " pkp-comment--reply" : "") +
        (selected ? " pkp-comment--selected" : "") +
        (isResolved ? " pkp-comment--resolved" : "") +
        (hasOrphanedAnchor ? " pkp-comment--orphaned" : "")
      }
      data-testid="comment-item"
      onClick={() => onSelect(comment.id)}
    >
      <div className="pkp-comment__header">
        <span
          className={
            "pkp-comment__author" +
            (comment.authorVerified ? "" : " pkp-comment__author--unverified")
          }
          title={
            comment.authorVerified
              ? comment.author
              : `${comment.author} ${labels.unverifiedSuffix}`
          }
          data-testid="comment-author"
        >
          {labels.formatAuthor(comment.author, undefined)}
          {!comment.authorVerified && (
            <span className="pkp-comment__unverified-badge">?</span>
          )}
        </span>
        <span className="pkp-comment__timestamp">
          {labels.formatAge(comment.ts)}
        </span>
      </div>

      <div className="pkp-comment__body">{comment.content}</div>

      {hasOrphanedAnchor && !isReply && (
        <div className="pkp-comment__orphan-note">{labels.orphanedNote}</div>
      )}

      <div className="pkp-comment__actions">
        {!isReply && !isResolved && (
          <button
            className="pkp-btn pkp-btn--sm"
            data-testid="reply-btn"
            onClick={(e) => {
              e.stopPropagation();
              onReply(comment.id);
            }}
          >
            {labels.replyButton}
          </button>
        )}
        {!isReply && !isResolved && (
          <button
            className="pkp-btn pkp-btn--sm"
            data-testid="resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
          >
            {labels.resolveButton}
          </button>
        )}
        {!isReply && isResolved && (
          <button
            className="pkp-btn pkp-btn--sm"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(comment.id);
            }}
          >
            {labels.reopenButton}
          </button>
        )}
        {isAuthor && (
          <button
            className="pkp-btn pkp-btn--sm pkp-btn--danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(comment.id);
            }}
          >
            {labels.deleteButton}
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
  labels,
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
  labels: Required<CommentSidebarLabels>;
}) {
  const isResolved = comment.data.status === "resolved";

  return (
    <div
      className={
        "pkp-comment-thread" +
        (isResolved ? " pkp-comment-thread--resolved" : "")
      }
    >
      <CommentItemView
        comment={comment}
        isReply={false}
        myPubkey={myPubkey}
        onReply={onReply}
        onResolve={onResolve}
        onReopen={onReopen}
        onDelete={onDelete}
        onSelect={onSelect}
        selected={selectedId === comment.id}
        labels={labels}
      />

      {comment.children.map((reply) => (
        <CommentItemView
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
          labels={labels}
        />
      ))}

      {replyingTo === comment.id && (
        <div className="pkp-comment-thread__reply-input">
          <CommentInput
            placeholder={labels.replyPlaceholder}
            submitLabel={labels.replyButton}
            cancelLabel={labels.cancelButton}
            onSubmit={(content) => onSubmitReply(comment.id, content)}
            onCancel={onCancelReply}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

// ── Sorting ─────────────────────────────────────

/** Sort top-level comments by anchor document
 *  position. Unanchored comments go to the end,
 *  ordered by timestamp. */
function sortByPosition(
  items: Comment<CommentData>[],
  positions: Map<string, number>,
): Comment<CommentData>[] {
  return [...items].sort((a, b) => {
    const posA = positions.get(a.id);
    const posB = positions.get(b.id);
    if (posA != null && posB != null) {
      return posA - posB;
    }
    // Anchored comments before unanchored
    if (posA != null) return -1;
    if (posB != null) return 1;
    // Both unanchored — sort by timestamp
    return a.ts - b.ts;
  });
}

// ── Spatial positioning ─────────────────────────

/** Compute spatial Y offsets for comment threads.
 *  Returns a Map of commentId → top (px) relative
 *  to the sidebar body container. Falls back to
 *  null when coordsAtPos is unavailable. */
function computeSpatialPositions(
  items: Comment<CommentData>[],
  positions: Map<string, number>,
  editorView: EditorView | null,
  bodyEl: HTMLElement | null,
  threadRefs: Map<string, HTMLElement>,
): Map<string, number> | null {
  if (!editorView || !bodyEl || items.length === 0) {
    return null;
  }

  const bodyRect = bodyEl.getBoundingClientRect();
  const layoutItems: LayoutItem[] = [];

  for (const c of items) {
    const pos = positions.get(c.id);
    const el = threadRefs.get(c.id);
    if (pos == null || !el) continue;

    try {
      const coords = editorView.coordsAtPos(pos);
      const desiredY = coords.top - bodyRect.top;
      layoutItems.push({
        id: c.id,
        desiredY: Math.max(0, desiredY),
        height: el.offsetHeight,
      });
    } catch {
      // Position may be out of range
    }
  }

  if (layoutItems.length === 0) return null;

  const laid = spatialLayout(layoutItems);
  return new Map(laid.map((p) => [p.id, p.y]));
}

// ── Props ───────────────────────────────────────

export interface CommentSidebarProps {
  comments: Comment<CommentData>[];
  anchorPositions: Map<string, number>;
  editorView: EditorView | null;
  myPubkey: string | null;
  /** True if a pending anchor is captured. */
  hasPendingAnchor: boolean;
  status: DocStatus;
  onAddComment: (content: string) => void;
  onAddReply: (parentId: string, content: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional i18n label overrides. */
  labels?: CommentSidebarLabels;
  /**
   * Optional display name map (pubkey → name).
   * When provided, formatAuthor receives the
   * display name for known authors.
   */
  displayNames?: Map<string, string>;
  /** Additional CSS class for the root element. */
  className?: string;
}

// ── Main sidebar ─────────────────────────────────

export function CommentSidebar({
  comments: allComments,
  anchorPositions,
  editorView,
  myPubkey,
  hasPendingAnchor,
  status,
  onAddComment,
  onAddReply,
  onResolve,
  onReopen,
  onDelete,
  onClose,
  selectedId,
  onSelect,
  labels: labelOverrides,
  displayNames,
  className,
}: CommentSidebarProps) {
  const labels = resolveSidebarLabels(labelOverrides);

  // Wrap formatAuthor to inject displayNames
  const resolvedLabels = useMemo(
    () => ({
      ...labels,
      formatAuthor: (pubkey: string, _displayName?: string) =>
        labels.formatAuthor(pubkey, displayNames?.get(pubkey)),
    }),
    [labels, displayNames],
  );

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const threadRefsRef = useRef(new Map<string, HTMLElement>());
  const [spatialYs, setSpatialYs] = useState<Map<string, number> | null>(null);

  const openComments = useMemo(
    () =>
      sortByPosition(
        allComments.filter((c) => c.data.status === "open"),
        anchorPositions,
      ),
    [allComments, anchorPositions],
  );

  const resolvedComments = useMemo(
    () =>
      sortByPosition(
        allComments.filter((c) => c.data.status === "resolved"),
        anchorPositions,
      ),
    [allComments, anchorPositions],
  );

  const handleSubmitReply = useCallback(
    (parentId: string, content: string) => {
      onAddReply(parentId, content);
      setReplyingTo(null);
    },
    [onAddReply],
  );

  // Recompute spatial positions on scroll/resize
  const recomputeLayout = useCallback(() => {
    const yPositions = computeSpatialPositions(
      openComments,
      anchorPositions,
      editorView,
      bodyRef.current,
      threadRefsRef.current,
    );
    setSpatialYs(yPositions);
  }, [openComments, anchorPositions, editorView]);

  useEffect(() => {
    requestAnimationFrame(recomputeLayout);
  }, [recomputeLayout]);

  useEffect(() => {
    const onScroll = () => {
      requestAnimationFrame(recomputeLayout);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [recomputeLayout]);

  const useSpatial = spatialYs != null && spatialYs.size > 0;

  const spatialHeight = useMemo(() => {
    if (!useSpatial) return undefined;
    let maxBottom = 0;
    for (const c of openComments) {
      const y = spatialYs.get(c.id);
      const el = threadRefsRef.current.get(c.id);
      if (y != null && el) {
        maxBottom = Math.max(maxBottom, y + el.offsetHeight);
      }
    }
    return maxBottom > 0 ? maxBottom + 16 : undefined;
  }, [useSpatial, spatialYs, openComments]);

  return (
    <div
      className={"pkp-comment-sidebar" + (className ? ` ${className}` : "")}
      role="complementary"
      aria-label={labels.title}
      data-testid="comment-sidebar"
    >
      <div className="pkp-comment-sidebar__header">
        <h3>{labels.title}</h3>
        <button
          className="pkp-comment-sidebar__close"
          onClick={onClose}
          aria-label={labels.closeAriaLabel}
        >
          &times;
        </button>
      </div>

      {(status === "offline" || status === "connecting") && (
        <div
          className={`pkp-comment-sidebar__sync-warning pkp-comment-sidebar__sync-warning--${status}`}
          role="alert"
        >
          {status === "offline"
            ? labels.offlineWarning
            : labels.connectingWarning}
        </div>
      )}

      <div
        className="pkp-comment-sidebar__body"
        ref={bodyRef}
        style={
          useSpatial
            ? {
                position: "relative",
                minHeight: spatialHeight,
              }
            : undefined
        }
      >
        {hasPendingAnchor && myPubkey && (
          <div className="pkp-comment-sidebar__new-comment">
            <CommentInput
              placeholder={labels.commentPlaceholder}
              submitLabel={labels.submitButton}
              cancelLabel={labels.cancelButton}
              onSubmit={onAddComment}
              autoFocus
            />
          </div>
        )}

        {!hasPendingAnchor && myPubkey && (
          <div className="pkp-comment-sidebar__hint">
            {labels.selectionHint}
          </div>
        )}

        {openComments.length === 0 && resolvedComments.length === 0 && (
          <div className="pkp-comment-sidebar__empty">{labels.emptyState}</div>
        )}

        {openComments.map((comment) => (
          <div
            key={comment.id}
            ref={(el) => {
              if (el) {
                threadRefsRef.current.set(comment.id, el);
              } else {
                threadRefsRef.current.delete(comment.id);
              }
            }}
            style={
              useSpatial && spatialYs.has(comment.id)
                ? {
                    position: "absolute",
                    top: spatialYs.get(comment.id),
                    left: 0,
                    right: 0,
                  }
                : undefined
            }
          >
            <CommentThread
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
              labels={resolvedLabels}
            />
          </div>
        ))}

        {resolvedComments.length > 0 && (
          <div
            style={
              useSpatial && spatialHeight
                ? { marginTop: spatialHeight }
                : undefined
            }
          >
            <button
              className="pkp-comment-sidebar__resolved-toggle"
              onClick={() => setShowResolved((s) => !s)}
            >
              {labels.resolvedToggle(resolvedComments.length, showResolved)}
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
                  labels={resolvedLabels}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
