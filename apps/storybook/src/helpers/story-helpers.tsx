import { useState } from "react";

/**
 * Shared helpers for Storybook stories — extracted
 * to avoid duplication across component and pattern
 * stories.
 */

// ── relativeAge ────────────────────────────────

export function relativeAge(ts: number, now: number = Date.now()): string {
  const sec = Math.round((now - ts) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// ── Badge ──────────────────────────────────────

const badgeColors: Record<string, { bg: string; fg: string }> = {
  admin: {
    bg: "var(--poka-surface-info)",
    fg: "var(--poka-on-info)",
  },
  writer: {
    bg: "var(--poka-surface-success)",
    fg: "var(--poka-on-success)",
  },
  reader: {
    bg: "var(--poka-bg-subtle)",
    fg: "var(--poka-text-secondary)",
  },
};

export function Badge({ role }: { role: "admin" | "writer" | "reader" }) {
  const { bg, fg } = badgeColors[role]!;
  return (
    <span
      style={{
        fontSize: "var(--poka-text-2xs)",
        fontWeight: "var(--poka-weight-medium)" as unknown as number,
        padding: "2px 8px",
        borderRadius: "var(--poka-radius-full)",
        background: bg,
        color: fg,
        textTransform: "capitalize",
      }}
    >
      {role}
    </span>
  );
}

// ── LockIcon ───────────────────────────────────

export function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ── Dot ────────────────────────────────────────

export function Dot({
  state,
}: {
  state: "connected" | "disconnected" | "partial";
}) {
  const color =
    state === "connected"
      ? "var(--poka-color-synced)"
      : state === "partial"
        ? "var(--poka-color-connecting)"
        : "var(--poka-color-offline)";
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}

// ── Sparkline ──────────────────────────────────

function normalizePoints(
  data: number[],
  width: number,
  height: number,
  pad: number,
): string[] {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  return data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - 2 * pad) + pad;
    const y = height - pad - ((v - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  });
}

export function Sparkline({
  data,
  color,
  width = 300,
  height = 40,
  pad = 2,
  label,
  current,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
  pad?: number;
  label?: string;
  current?: number;
}) {
  if (data.length < 2) return null;
  const pts = normalizePoints(data, width, height, pad);
  const line = pts.join(" ");
  const last = pts[pts.length - 1]!.split(",");

  return (
    <div>
      {label !== undefined && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
            marginBottom: 2,
          }}
        >
          <span>{label}</span>
          {current !== undefined && (
            <span
              style={{
                fontWeight: "var(--poka-weight-medium)" as unknown as number,
                color: "var(--poka-text-secondary)",
              }}
            >
              {current}
            </span>
          )}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        style={{ width: "100%", height }}
      >
        <polygon
          points={line + ` ${width - pad},${height}` + ` ${pad},${height}`}
          fill={color}
          fillOpacity="0.08"
        />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle cx={last[0]!} cy={last[1]!} r="2.5" fill={color} />
      </svg>
    </div>
  );
}

// ── CopyRow ────────────────────────────────────

export function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const truncated =
    value.length > 55
      ? value.slice(0, 28) + "\u2026" + value.slice(-18)
      : value;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--poka-space-1)",
        padding: "var(--poka-space-3)",
        background: "var(--poka-bg-subtle)",
        borderRadius: "var(--poka-radius-md)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--poka-space-2)",
        }}
      >
        <span
          style={{
            fontSize: "var(--poka-text-xs)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            color: "var(--poka-text-primary)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
          }}
        >
          {description}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--poka-space-2)",
        }}
      >
        <input
          type="text"
          readOnly
          value={truncated}
          title={value}
          style={{
            flex: 1,
            fontSize: "var(--poka-text-2xs)",
            fontFamily: "monospace",
            padding: "4px 8px",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-sm)",
            background: "var(--poka-bg-surface)",
            color: "var(--poka-text-secondary)",
          }}
        />
        <button
          onClick={() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          style={{
            fontSize: "var(--poka-text-2xs)",
            fontWeight: "var(--poka-weight-medium)" as unknown as number,
            padding: "4px 10px",
            borderRadius: "var(--poka-radius-sm)",
            border: "1px solid " + "var(--poka-color-accent)",
            background: copied ? "var(--poka-color-accent)" : "transparent",
            color: copied ? "#ffffff" : "var(--poka-color-accent)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
