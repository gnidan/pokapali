import { useState, useEffect } from "react";

interface ValidationError {
  cid: string;
  message: string;
}

export function ValidationWarning({
  error,
}: {
  error: ValidationError | null;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Reset dismissed state when a new error arrives
  // (different CID than the one we dismissed).
  useEffect(() => {
    if (error && error.cid !== dismissed) {
      setDismissed(null);
    }
  }, [error, dismissed]);

  if (!error || error.cid === dismissed) return null;

  const shortCid =
    error.cid.length > 16 ? error.cid.slice(0, 16) + "…" : error.cid;

  return (
    <div
      className="validation-warning"
      role="alert"
      aria-live="polite"
      title={`Rejected snapshot: ${error.cid}`}
    >
      <span className="validation-warning-text">
        A received update was rejected (invalid signature)
      </span>
      <span className="validation-warning-cid" aria-hidden="true">
        {shortCid}
      </span>
      <button
        className="validation-warning-dismiss"
        onClick={() => setDismissed(error.cid)}
        aria-label="Dismiss warning"
      >
        ×
      </button>
    </div>
  );
}
