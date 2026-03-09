import type { DocStatus } from "@pokapali/core";

const labels: Record<DocStatus, string> = {
  connecting: "Connecting",
  synced: "Synced",
  receiving: "Receiving",
  offline: "Offline",
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
