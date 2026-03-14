import { useState, useEffect, useCallback, useRef } from "react";

interface CommentPopoverProps {
  onComment: () => void;
}

interface Position {
  top: number;
  left: number;
}

const OFFSET = 6;
const BTN_SIZE = 32;

function getSelectionPosition(): Position | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }

  // Only show for selections inside the editor
  const anchor = sel.anchorNode;
  if (!anchor) return null;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  if (!el?.closest(".ProseMirror")) return null;

  const range = sel.getRangeAt(0);

  // Use a collapsed range at the selection end
  // so multi-line selections position near the
  // cursor, not at the full bounding rect corner.
  const endRange = document.createRange();
  endRange.setStart(range.endContainer, range.endOffset);
  endRange.collapse(true);
  const endRect = endRange.getBoundingClientRect();

  // Fall back to the full range rect if the
  // collapsed end has no dimensions (edge case).
  const rect = endRect.height > 0 ? endRect : range.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Default: just below and right of selection end
  let top = rect.bottom + OFFSET;
  let left = rect.right + OFFSET;

  // Flip vertically if near bottom
  if (top + BTN_SIZE > vh) {
    top = rect.top - BTN_SIZE - OFFSET;
  }

  // Flip horizontally if near right edge
  if (left + BTN_SIZE > vw) {
    left = rect.left - BTN_SIZE - OFFSET;
  }

  // Clamp to viewport
  top = Math.max(4, Math.min(top, vh - BTN_SIZE - 4));
  left = Math.max(4, Math.min(left, vw - BTN_SIZE - 4));

  return { top, left };
}

export function CommentPopover({ onComment }: CommentPopoverProps) {
  const [position, setPosition] = useState<Position | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const update = useCallback(() => {
    setPosition(getSelectionPosition());
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setPosition(null);
    }
  }, []);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Don't dismiss for clicks inside ProseMirror
    // or the comment sidebar
    if (target.closest(".ProseMirror") || target.closest(".cs-sidebar")) {
      return;
    }

    // Don't dismiss for clicks on the popover itself
    if (popoverRef.current?.contains(target)) {
      return;
    }

    setPosition(null);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [update, handleKeyDown, handleClickOutside]);

  if (!position) return null;

  return (
    <div
      ref={popoverRef}
      className="comment-popover"
      data-testid="comment-popover"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
      }}
    >
      <button
        className="comment-popover-btn"
        data-testid="add-comment-btn"
        title="Add comment"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onComment}
      >
        💬
      </button>
    </div>
  );
}
