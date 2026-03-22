import { useState, useEffect } from "react";
import type { SaveState } from "@pokapali/core";

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

function resolveLabels(
  partial?: Partial<SaveIndicatorLabels>,
): SaveIndicatorLabels {
  if (!partial) return defaultSaveIndicatorLabels;
  return { ...defaultSaveIndicatorLabels, ...partial };
}

// ── Helpers ─────────────────────────────────────

function saveLabel(
  labels: SaveIndicatorLabels,
  saveState: SaveState,
  ackCount: number,
): string {
  if (saveState === "saved" && ackCount > 0) {
    return labels.savedWithAcks(ackCount);
  }
  switch (saveState) {
    case "saved":
      return labels.saved;
    case "dirty":
      return labels.dirty;
    case "saving":
      return labels.saving;
    case "unpublished":
      return labels.unpublished;
    case "save-error":
      return labels.saveError;
  }
}

function formatAge(timestamp: number): string {
  const sec = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

// ── SaveIndicator ───────────────────────────────

export interface SaveIndicatorProps {
  saveState: SaveState;
  ackCount: number;
  onPublish: () => void;
  labels?: Partial<SaveIndicatorLabels>;
}

export function SaveIndicator({
  saveState,
  ackCount,
  onPublish,
  labels: labelOverrides,
}: SaveIndicatorProps) {
  const labels = resolveLabels(labelOverrides);
  const canPublish = saveState === "dirty" || saveState === "unpublished";
  const label = saveLabel(labels, saveState, ackCount);

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

export function LastUpdated({
  timestamp,
  flash,
  labels: labelOverrides,
}: LastUpdatedProps) {
  const labels = resolveLabels(labelOverrides);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={
        "poka-last-updated" + (flash ? " poka-last-updated--flashing" : "")
      }
      aria-live="polite"
    >
      {labels.lastUpdated(formatAge(timestamp))}
    </span>
  );
}
