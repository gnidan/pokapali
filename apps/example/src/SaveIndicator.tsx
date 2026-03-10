import { useState, useEffect } from "react";
import type { SaveState } from "@pokapali/core";
import { formatAge } from "./utils";

function saveLabel(
  saveState: SaveState,
  ackCount: number,
): string {
  if (saveState === "saved" && ackCount > 0) {
    return `Saved to ${ackCount} ${ackCount === 1 ? "pinner" : "pinners"}`;
  }
  switch (saveState) {
    case "saved": return "Published";
    case "dirty": return "Publish changes";
    case "saving": return "Saving\u2026";
    case "unpublished": return "Publish now";
  }
}

export function SaveIndicator({
  saveState,
  ackCount,
  onPublish,
}: {
  saveState: SaveState;
  ackCount: number;
  onPublish: () => void;
}) {
  const canPublish =
    saveState === "dirty" ||
    saveState === "unpublished";

  const label = saveLabel(saveState, ackCount);

  if (canPublish) {
    return (
      <button
        className={`save-state save-action ${saveState}`}
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
      className={`save-state ${saveState}`}
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
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => forceUpdate((n) => n + 1),
      5_000,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={
        "last-updated" + (flash ? " flashing" : "")
      }
      aria-live="polite"
    >
      Last updated: {formatAge(timestamp)}
    </span>
  );
}
