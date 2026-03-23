import type { SaveState } from "@pokapali/core";
import {
  type SaveIndicatorLabels,
  defaultSaveIndicatorLabels,
} from "./save-indicator.js";

export interface SaveLabelResult {
  /** Resolved display label for the current state. */
  label: string;
  /** True when the user can trigger a publish. */
  canPublish: boolean;
  /** The raw save state, forwarded for styling. */
  saveState: SaveState;
}

/**
 * Derive a human-readable save label and action state
 * from a {@link SaveState} and pinner ack count.
 *
 * This is the logic previously embedded inside
 * {@link SaveIndicator}. Use it to build your own
 * save-status UI without depending on the library's
 * markup.
 */
export function useSaveLabel(
  saveState: SaveState,
  ackCount: number,
  labelOverrides?: Partial<SaveIndicatorLabels>,
): SaveLabelResult {
  const labels = labelOverrides
    ? { ...defaultSaveIndicatorLabels, ...labelOverrides }
    : defaultSaveIndicatorLabels;

  let label: string;
  if (saveState === "saved" && ackCount > 0) {
    label = labels.savedWithAcks(ackCount);
  } else {
    switch (saveState) {
      case "saved":
        label = labels.saved;
        break;
      case "dirty":
        label = labels.dirty;
        break;
      case "saving":
        label = labels.saving;
        break;
      case "unpublished":
        label = labels.unpublished;
        break;
      case "save-error":
        label = labels.saveError;
        break;
    }
  }

  const canPublish = saveState === "dirty" || saveState === "unpublished";

  return { label, canPublish, saveState };
}
