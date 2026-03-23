import type { SaveState } from "@pokapali/core";
import { useSaveLabel, useLastUpdated } from "@pokapali/react";

export function SaveIndicator({
  saveState,
  ackCount,
  onPublish,
}: {
  saveState: SaveState;
  ackCount: number;
  onPublish: () => void;
}) {
  const { label, canPublish } = useSaveLabel(saveState, ackCount);

  if (canPublish) {
    return (
      <button
        className={
          "poka-save-indicator" +
          " poka-save-indicator--action" +
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

export function LastUpdated({
  timestamp,
  flash,
}: {
  timestamp: number;
  flash: boolean;
}) {
  const { label } = useLastUpdated(timestamp);

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
