import { useState, useCallback, useRef, useEffect, forwardRef } from "react";
import type { Doc } from "@pokapali/core";
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
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <div className="share-card">
      <div className="share-card-header">
        <span className="share-card-label">{label}</span>
        <span className="share-card-desc">{description}</span>
      </div>
      <div className="share-card-row">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={focused ? value : truncateUrl(value)}
          title={value}
          onFocus={() => {
            setFocused(true);
            // Select after React re-renders with
            // the full URL value
            requestAnimationFrame(() => {
              inputRef.current?.select();
            });
          }}
          onBlur={() => setFocused(false)}
        />
        <button className="copy-btn" onClick={copy}>
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export const SharePanel = forwardRef<HTMLDivElement, { doc: Doc }>(
  function SharePanel({ doc }, ref) {
    return (
      <div
        className="share-panel"
        ref={ref}
        tabIndex={-1}
        role="region"
        aria-label="Share panel"
      >
        <h2>Share this document</h2>
        {doc.urls.admin && (
          <CopyRow
            label="Admin"
            description={
              "Full control \u2014 can edit, publish," + " and manage access"
            }
            value={doc.urls.admin}
          />
        )}
        {doc.urls.write && (
          <CopyRow
            label="Write"
            description={"Can edit the document and publish" + " snapshots"}
            value={doc.urls.write}
          />
        )}
        <CopyRow
          label="Read"
          description="View only — cannot make changes"
          value={doc.urls.read}
        />
      </div>
    );
  },
);
