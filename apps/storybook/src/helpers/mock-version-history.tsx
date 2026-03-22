/**
 * Shared VersionHistory mock data and components
 * for Storybook stories. Used by both the component
 * story and the HistoryPreview pattern story.
 */

import { relativeAge } from "./story-helpers";

// ── Types ──────────────────────────────────────

export interface MockVersion {
  seq: number;
  ts: number;
  delta?: number;
  status?: "archived" | "unavailable" | null;
  tier?: string;
  expiresAt?: number;
  current?: boolean;
  selected?: boolean;
}

// ── VersionItem ────────────────────────────────

export function VersionItem({
  v,
  isCurrent = false,
  isSelected = false,
  onClick,
}: {
  v: MockVersion;
  isCurrent?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const disabled = v.status === "archived" || v.status === "unavailable";
  const statusClass =
    v.status === "archived"
      ? " archived"
      : v.status === "unavailable"
        ? " unavailable"
        : "";
  const deltaClass =
    v.delta !== undefined
      ? v.delta > 0
        ? " added"
        : v.delta < 0
          ? " removed"
          : " unchanged"
      : "";

  return (
    <button
      className={"vh-item" + (isSelected ? " selected" : "") + statusClass}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="vh-item-seq">
        #{v.seq}
        {(isCurrent || v.current) && (
          <span className="vh-current-badge">current</span>
        )}
      </span>
      {v.delta !== undefined && (
        <span className={"vh-item-delta" + deltaClass}>
          {v.delta > 0
            ? `+${v.delta}`
            : v.delta < 0
              ? String(v.delta)
              : "\u00b10"}
        </span>
      )}
      <span className="vh-item-ts">{relativeAge(v.ts)}</span>
      {v.tier && v.tier !== "tip" && (
        <span className={"vh-item-retention vh-tier-" + v.tier}>{v.tier}</span>
      )}
    </button>
  );
}

// ── Drawer wrapper ─────────────────────────────
// Overrides .vh-drawer absolute positioning from
// the example app CSS so it renders in normal
// document flow within Storybook.

export function VersionDrawer({
  children,
  width = 300,
  maxHeight = 500,
}: {
  children: React.ReactNode;
  width?: number;
  maxHeight?: number;
}) {
  return (
    <div
      className="vh-drawer"
      style={{
        position: "relative",
        top: "auto",
        right: "auto",
        width,
        maxHeight,
        boxShadow: "none",
      }}
    >
      {children}
    </div>
  );
}
