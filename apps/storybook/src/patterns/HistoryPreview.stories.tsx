import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  type MockVersion,
  VersionItem,
  VersionDrawer,
} from "../helpers/mock-version-history";

/**
 * History & Preview pattern — shows the version
 * history drawer alongside mock editor content with
 * a preview overlay, demonstrating the interaction
 * between selecting a version and viewing it.
 */

const NOW = Date.now();
const HOUR = 3_600_000;

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
        <VersionDrawer width={260}>
          <div className="vh-header">
            <h3>Version history</h3>
            <button className="vh-close" aria-label="Close">
              &#x2715;
            </button>
          </div>
          <div
            className="vh-list-section"
            style={{
              maxHeight: 380,
              overflow: "auto",
            }}
          >
            {versions.map((v) => (
              <VersionItem
                key={v.seq}
                v={v}
                isCurrent={v.seq === versions[0]!.seq}
                isSelected={selectedSeq === v.seq}
                onClick={() =>
                  setSelectedSeq(selectedSeq === v.seq ? null : v.seq)
                }
              />
            ))}
          </div>
        </VersionDrawer>
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
