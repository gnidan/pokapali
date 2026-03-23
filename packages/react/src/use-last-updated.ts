import { useState, useEffect } from "react";
import {
  type SaveIndicatorLabels,
  defaultSaveIndicatorLabels,
} from "./save-indicator.js";

export interface LastUpdatedResult {
  /** Formatted "Last updated: Xm ago" string. */
  label: string;
  /** The raw age string (e.g. "just now", "5m ago"). */
  age: string;
}

function formatAge(timestamp: number): string {
  const sec = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/**
 * Derive a human-readable "last updated" label that
 * auto-refreshes every 5 seconds.
 *
 * This is the logic previously embedded inside
 * {@link LastUpdated}. Use it to build your own
 * last-updated UI without depending on the library's
 * markup.
 */
export function useLastUpdated(
  timestamp: number,
  labelOverrides?: Partial<SaveIndicatorLabels>,
): LastUpdatedResult {
  const labels = labelOverrides
    ? { ...defaultSaveIndicatorLabels, ...labelOverrides }
    : defaultSaveIndicatorLabels;

  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  const age = formatAge(timestamp);
  const label = labels.lastUpdated(age);

  return { label, age };
}
