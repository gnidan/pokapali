import type { DocStatus } from "@pokapali/core";
import { useStatusLabel } from "./use-status-label.js";

// ── Labels ──────────────────────────────────────

export interface StatusIndicatorLabels {
  synced: string;
  receiving: string;
  connecting: string;
  offline: string;
  connectingWarning: string;
  offlineWarning: string;
  connectionLabel: (status: string, warning?: string) => string;
}

export const defaultStatusIndicatorLabels: StatusIndicatorLabels = {
  synced: "Live",
  receiving: "Subscribed",
  connecting: "Connecting\u2026",
  offline: "Offline",
  connectingWarning: "Changes may not sync yet",
  offlineWarning: "Changes won\u2019t sync until reconnected",
  connectionLabel: (status, warning) =>
    warning
      ? `Connection: ${status} \u2014 ${warning}`
      : `Connection: ${status}`,
};

// ── Component ───────────────────────────────────

export interface StatusIndicatorProps {
  status: DocStatus;
  labels?: Partial<StatusIndicatorLabels>;
}

/**
 * @deprecated Use {@link useStatusLabel} hook instead
 * and render your own markup. This component will be
 * removed in a future release.
 */
export function StatusIndicator({
  status,
  labels: labelOverrides,
}: StatusIndicatorProps) {
  const { label, warning, ariaLabel, degraded } = useStatusLabel(
    status,
    labelOverrides,
  );

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
