import type { DocStatus } from "@pokapali/core";

const labels: Record<DocStatus, string> = {
  connecting: "Connecting",
  syncing: "Syncing",
  synced: "Synced",
  offline: "Offline",
  "unpushed-changes": "Unpushed changes",
};

export function StatusIndicator({ status }: { status: DocStatus }) {
  return <span className={`status-dot ${status}`} title={labels[status]} />;
}
