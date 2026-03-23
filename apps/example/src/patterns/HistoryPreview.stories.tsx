import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { Doc, VersionEntry } from "@pokapali/core";
import { VersionHistory } from "../VersionHistory";
import type { VersionHistoryData } from "../useVersionHistory";

/**
 * History & Preview pattern — shows the version
 * history drawer alongside mock editor content with
 * a preview overlay, demonstrating the interaction
 * between selecting a version and viewing it.
 */

const NOW = Date.now();
const HOUR = 3_600_000;

const mockVersions: VersionEntry[] = [
  {
    cid: "bafyreicurrent" as unknown as VersionEntry["cid"],
    seq: 8,
    ts: NOW - 5_000,
  },
  {
    cid: "bafyreiseq7" as unknown as VersionEntry["cid"],
    seq: 7,
    ts: NOW - 25 * 60_000,
  },
  {
    cid: "bafyreiseq6" as unknown as VersionEntry["cid"],
    seq: 6,
    ts: NOW - 2 * HOUR,
    tier: "daily",
  },
  {
    cid: "bafyreiseq5" as unknown as VersionEntry["cid"],
    seq: 5,
    ts: NOW - 5 * HOUR,
  },
  {
    cid: "bafyreiseq4" as unknown as VersionEntry["cid"],
    seq: 4,
    ts: NOW - 12 * HOUR,
  },
  {
    cid: "bafyreiseq3" as unknown as VersionEntry["cid"],
    seq: 3,
    ts: NOW - 36 * HOUR,
    tier: "daily",
  },
  {
    cid: "bafyreiseq1" as unknown as VersionEntry["cid"],
    seq: 1,
    ts: NOW - 72 * HOUR,
  },
];

const mockDeltas = new Map<number, number>([
  [8, 42],
  [7, -8],
  [6, 156],
  [5, 23],
  [4, 0],
  [3, -18],
  [1, 50],
]);

function mockHistory(): VersionHistoryData {
  return {
    versions: mockVersions,
    listState: { status: "idle" },
    versionTexts: new Map(),
    deltas: mockDeltas,
    visibleVersions: mockVersions.filter(
      (v) => (mockDeltas.get(v.seq) ?? 1) !== 0,
    ),
    settling: false,
  };
}

function mockDoc(): Doc {
  return {
    tipCid: "bafyreicurrent",
    loadVersion: () => Promise.resolve({ content: null }),
  } as unknown as Doc;
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

function HistoryPreviewPattern() {
  const [previewing, setPreviewing] = useState<number | null>(null);

  return (
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
        <div
          style={{
            background: "var(--poka-bg-surface)",
            border: "1px solid var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            padding: "var(--poka-space-4)",
            fontSize: "var(--poka-text-sm)",
            lineHeight: 1.6,
            color: "var(--poka-text-primary)",
            whiteSpace: "pre-wrap",
            visibility: previewing ? "hidden" : "visible",
            minHeight: 240,
          }}
        >
          {editorText}
        </div>

        {previewing && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--poka-bg-surface)",
              border: "2px solid var(--poka-color-accent)",
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
                Previewing version #{previewing}
              </span>
              <button
                onClick={() => setPreviewing(null)}
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

      {/* Real VersionHistory drawer */}
      <div
        style={{
          width: 280,
          minHeight: 400,
          position: "relative",
        }}
      >
        <VersionHistory
          doc={mockDoc()}
          history={mockHistory()}
          onClose={() => {}}
          onPreview={(entry) => setPreviewing(entry.seq)}
          onClosePreview={() => setPreviewing(null)}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof HistoryPreviewPattern> = {
  title: "Patterns/History & Preview",
  component: HistoryPreviewPattern,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
