import type { Meta, StoryObj } from "@storybook/react";

const sizes = [
  {
    token: "--poka-text-2xs",
    value: "0.65rem",
    usage: "Badges, timestamps, fine print",
  },
  {
    token: "--poka-text-xs",
    value: "0.72rem",
    usage: "Buttons, captions, indicator labels",
  },
  {
    token: "--poka-text-sm",
    value: "0.8rem",
    usage: "Panel body text, indicator text",
  },
  {
    token: "--poka-text-base",
    value: "0.95rem",
    usage: "Doc title, primary content",
  },
  { token: "--poka-text-lg", value: "1.25rem", usage: "Headings, app title" },
] as const;

function TypeScale() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Type Scale</h2>
      <p
        style={{
          color: "#64748b",
          fontSize: "0.8rem",
          marginBottom: "2rem",
        }}
      >
        5 sizes. All status-line elements (indicators, labels, timestamps) share
        the same scale steps.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {sizes.map(({ token, value, usage }) => (
          <div
            key={token}
            style={{
              display: "grid",
              gridTemplateColumns: "200px 80px 1fr",
              alignItems: "baseline",
              gap: "1rem",
            }}
          >
            <code
              style={{
                fontSize: "0.72rem",
                color: "#64748b",
                fontFamily: "monospace",
              }}
            >
              {token}
            </code>
            <span
              style={{
                fontSize: "0.72rem",
                color: "#94a3b8",
                fontFamily: "monospace",
              }}
            >
              {value}
            </span>
            <div>
              <span
                style={{
                  fontSize: `var(${token})`,
                  color: "#1a1a1a",
                }}
              >
                The quick brown fox jumps over the lazy dog
              </span>
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginTop: "0.25rem",
                }}
              >
                {usage}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof TypeScale> = {
  title: "Design System/Typography",
  component: TypeScale,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
