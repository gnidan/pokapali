import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * History & Preview pattern — shows the version
 * history drawer alongside mock editor content with
 * a preview overlay, demonstrating the interaction
 * between selecting a version and viewing it.
 */

const NOW = Date.now();
const HOUR = 3_600_000;

interface MockVersion {
  seq: number;
  ts: number;
  delta?: number;
  tier?: string;
  status?: "archived" | null;
}

const versions: MockVersion[] = [
  { seq: 8, ts: NOW - 5_000, delta: 42 },
  { seq: 7, ts: NOW - 25 * 60_000, delta: -8 },
  {
    seq: 6,
    ts: NOW - 2 * HOUR,
    delta: 156,
    tier: "guaranteed",
  },
  { seq: 5, ts: NOW - 5 * HOUR, delta: 23 },
  { seq: 4, ts: NOW - 12 * HOUR, delta: 0 },
  {
    seq: 3,
    ts: NOW - 36 * HOUR,
    delta: -18,
    tier: "guaranteed",
  },
  {
    seq: 1,
    ts: NOW - 72 * HOUR,
    status: "archived",
  },
];

function relativeAge(ts: number): string {
  const sec = Math.round((NOW - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const editorText = `The design system tokens provide a
consistent visual language across all
Pokapali interfaces. Each token follows
the --poka-{category}-{name} naming
convention and maps to a specific
semantic role.

Colors are organized into surface,
text, border, and status categories.
Typography tokens cover size, weight,
and line height. Spacing uses a 4px
base unit.`;

const previewText = `The design system provides a visual
language for Pokapali interfaces.
Tokens follow --poka-{category}-{name}
naming.

Colors cover surface, text, and border
categories. Typography covers size and
weight.`;

function HistoryPreviewPatterns() {
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>History &amp; Preview</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Right-side version history drawer with editor preview overlay. Clicking
        a version loads its snapshot and overlays the editor. The current
        version is highlighted; archived versions are disabled.
      </p>

      <div
        style={{
          display: "flex",
          gap: "var(--poka-space-4)",
          alignItems: "start",
        }}
      >
        {/* Editor / Preview area */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: "relative",
          }}
        >
          {/* Current editor content */}
          <div
            style={{
              background: "var(--poka-bg-surface)",
              border: "1px solid " + "var(--poka-border-default)",
              borderRadius: "var(--poka-radius-lg)",
              padding: "var(--poka-space-4)",
              fontSize: "var(--poka-text-sm)",
              lineHeight: 1.6,
              color: "var(--poka-text-primary)",
              whiteSpace: "pre-wrap",
              visibility: selectedSeq ? "hidden" : "visible",
              minHeight: 240,
            }}
          >
            {editorText}
          </div>

          {/* Preview overlay */}
          {selectedSeq && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "var(--poka-bg-surface)",
                border: "2px solid " + "var(--poka-color-accent)",
                borderRadius: "var(--poka-radius-lg)",
                padding: "var(--poka-space-4)",
                fontSize: "var(--poka-text-sm)",
                lineHeight: 1.6,
                color: "var(--poka-text-secondary)",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--poka-space-2)",
                  marginBottom: "var(--poka-space-3)",
                  paddingBottom: "var(--poka-space-2)",
                  borderBottom: "1px solid " + "var(--poka-border-default)",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--poka-text-xs)",
                    fontWeight:
                      "var(--poka-weight-semibold)" as unknown as number,
                    color: "var(--poka-color-accent)",
                  }}
                >
                  Previewing version #{selectedSeq}
                </span>
                <button
                  onClick={() => setSelectedSeq(null)}
                  style={{
                    marginLeft: "auto",
                    fontSize: "var(--poka-text-xs)",
                    color: "var(--poka-text-muted)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Close preview
                </button>
              </div>
              {previewText}
            </div>
          )}
        </div>

        {/* History drawer */}
        <div
          style={{
            width: 260,
            flexShrink: 0,
            background: "var(--poka-bg-surface)",
            border: "1px solid var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            overflow: "hidden",
          }}
        >
          <div
            className="vh-header"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--poka-space-3) " + "var(--poka-space-3)",
              borderBottom: "1px solid " + "var(--poka-border-default)",
            }}
          >
            <span
              style={{
                fontSize: "var(--poka-text-sm)",
                fontWeight: "var(--poka-weight-semibold)" as unknown as number,
                color: "var(--poka-text-primary)",
              }}
            >
              Version history
            </span>
            <span
              style={{
                fontSize: "var(--poka-text-xs)",
                color: "var(--poka-text-muted)",
              }}
            >
              &#x2715;
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 380,
              overflow: "auto",
            }}
          >
            {versions.map((v) => {
              const isCurrent = v.seq === versions[0]!.seq;
              const isSelected = selectedSeq === v.seq;
              const disabled = v.status === "archived";

              return (
                <button
                  key={v.seq}
                  className={
                    "vh-item" +
                    (isSelected ? " selected" : "") +
                    (disabled ? " archived" : "")
                  }
                  disabled={disabled}
                  onClick={() => setSelectedSeq(isSelected ? null : v.seq)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--poka-space-2)",
                    padding: "var(--poka-space-2) " + "var(--poka-space-3)",
                    background: isSelected
                      ? "var(--poka-surface-info)"
                      : "transparent",
                    border: "none",
                    borderBottom: "1px solid " + "var(--poka-border-default)",
                    cursor: disabled ? "default" : "pointer",
                    opacity: disabled ? 0.4 : 1,
                    textAlign: "left",
                    width: "100%",
                    fontSize: "var(--poka-text-xs)",
                  }}
                >
                  <span
                    style={{
                      fontWeight:
                        "var(--poka-weight-medium)" as unknown as number,
                      color: "var(--poka-text-primary)",
                    }}
                  >
                    #{v.seq}
                    {isCurrent && (
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: "var(--poka-text-2xs)",
                          color: "var(--poka-color-synced)",
                        }}
                      >
                        current
                      </span>
                    )}
                  </span>
                  {v.delta !== undefined && (
                    <span
                      style={{
                        color:
                          v.delta > 0
                            ? "var(--poka-color-synced)"
                            : v.delta < 0
                              ? "var(--poka-color-offline)"
                              : "var(--poka-text-muted)",
                        fontSize: "var(--poka-text-2xs)",
                      }}
                    >
                      {v.delta > 0
                        ? `+${v.delta}`
                        : v.delta < 0
                          ? String(v.delta)
                          : "\u00b10"}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "var(--poka-text-muted)",
                      fontSize: "var(--poka-text-2xs)",
                    }}
                  >
                    {relativeAge(v.ts)}
                  </span>
                  {v.tier && (
                    <span
                      style={{
                        fontSize: "var(--poka-text-2xs)",
                        padding: "1px 4px",
                        borderRadius: "var(--poka-radius-sm)",
                        background: "var(--poka-bg-subtle)",
                        color: "var(--poka-text-muted)",
                      }}
                    >
                      {v.tier}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof HistoryPreviewPatterns> = {
  title: "Patterns/History & Preview",
  component: HistoryPreviewPatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
