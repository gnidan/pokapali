import {
  useState,
  useCallback,
  useRef,
  useEffect,
  forwardRef,
} from "react";
import type { CollabDoc } from "@pokapali/core";
import { truncateUrl } from "@pokapali/core";

function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setCopied(false),
        1500,
      );
    });
  }, [value]);

  return (
    <div className="share-card">
      <div className="share-card-header">
        <span className="share-card-label">
          {label}
        </span>
        <span className="share-card-desc">
          {description}
        </span>
      </div>
      <div className="share-card-row">
        <input
          type="text"
          readOnly
          value={truncateUrl(value)}
          title={value}
          onFocus={(e) => {
            e.target.value = value;
            e.target.select();
          }}
          onBlur={(e) => {
            e.target.value = truncateUrl(value);
          }}
        />
        <button
          className="copy-btn"
          onClick={copy}
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export const SharePanel = forwardRef<
  HTMLDivElement,
  { doc: CollabDoc }
>(function SharePanel({ doc }, ref) {
  return (
    <div
      className="share-panel"
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label="Share panel"
    >
      <h2>Share this document</h2>
      {doc.adminUrl && (
        <CopyRow
          label="Admin"
          description={
            "Full control \u2014 can edit, publish," +
            " and manage access"
          }
          value={doc.adminUrl}
        />
      )}
      {doc.writeUrl && (
        <CopyRow
          label="Write"
          description={
            "Can edit the document and publish" +
            " snapshots"
          }
          value={doc.writeUrl}
        />
      )}
      <CopyRow
        label="Read"
        description="View only — cannot make changes"
        value={doc.readUrl}
      />
    </div>
  );
});
