import type { DocStatus } from "@pokapali/core";

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

function resolveLabels(
  partial?: Partial<StatusIndicatorLabels>,
): StatusIndicatorLabels {
  if (!partial) return defaultStatusIndicatorLabels;
  return { ...defaultStatusIndicatorLabels, ...partial };
}

// ── Component ───────────────────────────────────

export interface StatusIndicatorProps {
  status: DocStatus;
  labels?: Partial<StatusIndicatorLabels>;
}

export function StatusIndicator({
  status,
  labels: labelOverrides,
}: StatusIndicatorProps) {
  const labels = resolveLabels(labelOverrides);

  const statusLabel = labels[status];
  const warning =
    status === "connecting"
      ? labels.connectingWarning
      : status === "offline"
        ? labels.offlineWarning
        : undefined;

  return (
    <span
      className={
        "poka-status-indicator" +
        ` poka-status-indicator--${status}` +
        (warning ? " poka-status-indicator--degraded" : "")
      }
      role="status"
      aria-label={labels.connectionLabel(statusLabel, warning)}
    >
      <span
        className={
          "poka-status-indicator__dot" +
          ` poka-status-indicator__dot--${status}`
        }
        aria-hidden="true"
      />
      <span className="poka-status-indicator__text">{statusLabel}</span>
      {warning && (
        <span className="poka-status-indicator__warning">{warning}</span>
      )}
    </span>
  );
}
