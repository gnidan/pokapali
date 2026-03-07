import { useState, useCallback } from "react";
import type { CollabDoc } from "@pokapali/core";

function CopyRow(
  { label, value }: { label: string; value: string }
) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <div className="share-row">
      <label>{label}</label>
      <input type="text" readOnly value={value} />
      <button onClick={copy}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export function SharePanel(
  { doc }: { doc: CollabDoc }
) {
  return (
    <div className="share-panel">
      <h2>Share</h2>
      {doc.adminUrl && (
        <CopyRow label="Admin" value={doc.adminUrl} />
      )}
      {doc.writeUrl && (
        <CopyRow label="Write" value={doc.writeUrl} />
      )}
      <CopyRow label="Read" value={doc.readUrl} />
    </div>
  );
}
