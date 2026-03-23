import type { DocStatus } from "@pokapali/core";
import {
  type StatusIndicatorLabels,
  defaultStatusIndicatorLabels,
} from "./status-indicator.js";

export interface StatusLabelResult {
  /** Resolved display label (e.g. "Live", "Offline"). */
  label: string;
  /** Warning message, if the status is degraded. */
  warning: string | undefined;
  /** Full accessible label for screen readers. */
  ariaLabel: string;
  /** The raw doc status, forwarded for styling. */
  status: DocStatus;
  /** True when the status is degraded. */
  degraded: boolean;
}

/**
 * Derive a human-readable connection status label,
 * warning text, and accessibility label from a
 * {@link DocStatus}.
 *
 * This is the logic previously embedded inside
 * {@link StatusIndicator}. Use it to build your own
 * connection-status UI without depending on the
 * library's markup.
 */
export function useStatusLabel(
  status: DocStatus,
  labelOverrides?: Partial<StatusIndicatorLabels>,
): StatusLabelResult {
  const labels = labelOverrides
    ? { ...defaultStatusIndicatorLabels, ...labelOverrides }
    : defaultStatusIndicatorLabels;

  const label = labels[status];
  const warning =
    status === "connecting"
      ? labels.connectingWarning
      : status === "offline"
        ? labels.offlineWarning
        : undefined;

  const ariaLabel = labels.connectionLabel(label, warning);
  const degraded = warning !== undefined;

  return { label, warning, ariaLabel, status, degraded };
}
