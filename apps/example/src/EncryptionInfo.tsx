import { useEffect, useRef } from "react";

export function LockIcon(
  { size = 16 }: { size?: number },
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect
        x="3" y="11"
        width="18" height="11" rx="2"
      />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function EncryptionInfo({
  onClose,
}: {
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () =>
      document.removeEventListener(
        "mousedown",
        handler,
      );
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () =>
      document.removeEventListener(
        "keydown",
        handler,
      );
  }, [onClose]);

  return (
    <div ref={ref} className="encryption-popover">
      <div className="encryption-header">
        <LockIcon size={16} />
        End-to-end encrypted
      </div>
      <p>
        Relay and pinner nodes cannot read your
        content — they only store encrypted blocks.
      </p>
      <p>
        Only people with the document link can
        read it. Your link determines your access
        level: admin, writer, or reader.
      </p>
      <button
        className="encryption-close"
        onClick={onClose}
        aria-label="Close"
      >
        &#x2715;
      </button>
    </div>
  );
}
