import type { DocStatus } from "@pokapali/core";

const labels: Record<DocStatus, string> = {
  connecting: "Connecting",
  syncing: "Syncing",
  synced: "Synced",
  offline: "Offline",
  "unpushed-changes": "Unpushed changes",
};

export function StatusIndicator({
  status,
}: {
  status: DocStatus;
}) {
  return (
    <span
      className={`status-indicator ${status}`}
      role="status"
      aria-label={`Connection: ${labels[status]}`}
    >
      <span
        className={`status-dot ${status}`}
        aria-hidden="true"
      />
      <span className="status-text">
        {labels[status]}
      </span>
    </span>
  );
}
