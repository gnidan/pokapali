import type { Meta, StoryObj } from "@storybook/react";

const textLevels = [
  {
    token: "--poka-text-primary",
    value: "#1a1a1a",
    label: "Primary",
    sample: "Document title, headings, body text",
  },
  {
    token: "--poka-text-secondary",
    value: "#64748b",
    label: "Secondary",
    sample: "Labels, indicator text, panel content",
  },
  {
    token: "--poka-text-muted",
    value: "#94a3b8",
    label: "Muted",
    sample: "Timestamps, hints, disabled text",
  },
] as const;

function TextColorStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Text Colors</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        3 levels. Collapses 7+ different grays to a consistent hierarchy.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2rem",
        }}
      >
        {textLevels.map(({ token, value, label, sample }) => (
          <div key={token}>
            <div
              style={{
                fontSize: "var(--poka-text-base)",
                color: `var(${token})`,
                marginBottom: "0.25rem",
              }}
            >
              {sample}
            </div>
            <div
              style={{
                fontSize: "var(--poka-text-xs)",
                color: `var(${token})`,
                marginBottom: "0.5rem",
              }}
            >
              The quick brown fox jumps over the lazy dog. 0123456789.
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: `var(${token})`,
                  flexShrink: 0,
                }}
              />
              <div>
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color: "#1a1a1a",
                  }}
                >
                  {label}
                </span>
                <code
                  style={{
                    fontSize: "0.65rem",
                    color: "#64748b",
                    marginLeft: "0.75rem",
                  }}
                >
                  {token}
                </code>
                <span
                  style={{
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginLeft: "0.5rem",
                  }}
                >
                  {value}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof TextColorStories> = {
  title: "Design System/Text Colors",
  component: TextColorStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
