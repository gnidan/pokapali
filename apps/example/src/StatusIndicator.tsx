import type { DocStatus } from "@pokapali/core";

const labels: Record<DocStatus, string> = {
  synced: "Live",
  receiving: "Subscribed",
  connecting: "Connecting…",
  offline: "Offline",
};

const warnings: Partial<Record<DocStatus, string>> = {
  connecting: "Changes may not sync yet",
  offline: "Changes won't sync until reconnected",
};

export function StatusIndicator({ status }: { status: DocStatus }) {
  const warning = warnings[status];

  return (
    <span
      className={"status-indicator " + status + (warning ? " degraded" : "")}
      role="status"
      aria-label={
        warning
          ? `Connection: ${labels[status]} — ${warning}`
          : `Connection: ${labels[status]}`
      }
    >
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span className="status-text">{labels[status]}</span>
      {warning && <span className="status-warning">{warning}</span>}
    </span>
  );
}
