import type { DocStatus } from "@pokapali/core";
import { useStatusLabel } from "@pokapali/react";

export function StatusIndicator({ status }: { status: DocStatus }) {
  const { label, warning, ariaLabel, degraded } = useStatusLabel(status);

  return (
    <span
      className={
        "poka-status-indicator" +
        ` poka-status-indicator--${status}` +
        (degraded ? " poka-status-indicator--degraded" : "")
      }
      role="status"
      aria-label={ariaLabel}
    >
      <span
        className={
          "poka-status-indicator__dot" +
          ` poka-status-indicator__dot--${status}`
        }
        aria-hidden="true"
      />
      <span className="poka-status-indicator__text">{label}</span>
      {warning && (
        <span className="poka-status-indicator__warning">{warning}</span>
      )}
    </span>
  );
}
