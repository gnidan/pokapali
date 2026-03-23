import type { SaveState } from "@pokapali/core";
import { useSaveLabel } from "./use-save-label.js";
import { useLastUpdated } from "./use-last-updated.js";

// ── Labels ──────────────────────────────────────

export interface SaveIndicatorLabels {
  saved: string;
  savedWithAcks: (count: number) => string;
  dirty: string;
  saving: string;
  unpublished: string;
  saveError: string;
  lastUpdated: (age: string) => string;
}

export const defaultSaveIndicatorLabels: SaveIndicatorLabels = {
  saved: "Saved",
  savedWithAcks: (n) => `Saved to ${n} ${n === 1 ? "pinner" : "pinners"}`,
  dirty: "Save changes",
  saving: "Saving\u2026",
  unpublished: "Save now",
  saveError: "Save failed",
  lastUpdated: (age) => `Last updated: ${age}`,
};

// ── SaveIndicator ───────────────────────────────

export interface SaveIndicatorProps {
  saveState: SaveState;
  ackCount: number;
  onPublish: () => void;
  labels?: Partial<SaveIndicatorLabels>;
}

/**
 * @deprecated Use {@link useSaveLabel} hook instead
 * and render your own markup. This component will be
 * removed in a future release.
 */
export function SaveIndicator({
  saveState,
  ackCount,
  onPublish,
  labels: labelOverrides,
}: SaveIndicatorProps) {
  const { label, canPublish } = useSaveLabel(
    saveState,
    ackCount,
    labelOverrides,
  );

  if (canPublish) {
    return (
      <button
        className={
          "poka-save-indicator poka-save-indicator--action" +
          ` poka-save-indicator--${saveState}`
        }
        onClick={onPublish}
        role="status"
        aria-label={label}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className={"poka-save-indicator" + ` poka-save-indicator--${saveState}`}
      role="status"
      aria-live="polite"
    >
      {label}
    </span>
  );
}

// ── LastUpdated ─────────────────────────────────

export interface LastUpdatedProps {
  timestamp: number;
  flash: boolean;
  labels?: Partial<SaveIndicatorLabels>;
}

/**
 * @deprecated Use {@link useLastUpdated} hook instead
 * and render your own markup. This component will be
 * removed in a future release.
 */
export function LastUpdated({
  timestamp,
  flash,
  labels: labelOverrides,
}: LastUpdatedProps) {
  const { label } = useLastUpdated(timestamp, labelOverrides);

  return (
    <span
      className={
        "poka-last-updated" + (flash ? " poka-last-updated--flashing" : "")
      }
      aria-live="polite"
    >
      {label}
    </span>
  );
}
