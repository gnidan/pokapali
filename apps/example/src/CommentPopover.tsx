import { useState, useEffect, useCallback, useRef } from "react";

interface CommentPopoverProps {
  onComment: () => void;
}

interface Position {
  top: number;
  left: number;
}

const OFFSET = 6;

function getSelectionPosition(): Position | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Default: bottom-right of selection rect
  let top = rect.bottom + OFFSET;
  let left = rect.right + OFFSET;

  // Flip vertically if near bottom
  if (top + 40 > vh) {
    top = rect.top - 32 - OFFSET;
  }

  // Flip horizontally if near right edge
  if (left + 40 > vw) {
    left = rect.left - 32 - OFFSET;
  }

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
      role="tooltip"
      aria-label="Add comment"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
      }}
    >
      <button
        className="comment-popover-btn"
        title="Add comment"
        onClick={onComment}
      >
        💬
      </button>
    </div>
  );
}
