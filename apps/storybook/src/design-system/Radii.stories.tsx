import type { Meta, StoryObj } from "@storybook/react";

const radii = [
  { token: "--poka-radius-sm", value: "3px", usage: "Badges, inline elements" },
  { token: "--poka-radius-md", value: "6px", usage: "Buttons, inputs, cards" },
  {
    token: "--poka-radius-lg",
    value: "8px",
    usage: "Panels, popovers, drawers",
  },
  {
    token: "--poka-radius-full",
    value: "9999px",
    usage: "Dots, pills, circles",
  },
] as const;

function RadiiStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Border Radii</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        4 steps from sharp to fully round.
      </p>
      <div
        style={{
          display: "flex",
          gap: "1.5rem",
          flexWrap: "wrap",
          marginBottom: "2rem",
        }}
      >
        {radii.map(({ token, value, usage }) => (
          <div
            key={token}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.5rem",
              width: 120,
            }}
          >
            <div
              style={{
                width: token === "--poka-radius-full" ? 64 : 80,
                height: token === "--poka-radius-full" ? 64 : 48,
                borderRadius: `var(${token})`,
                background: "var(--poka-bg-subtle)",
                border: "2px solid var(--poka-border-default)",
              }}
            />
            <code
              style={{
                fontSize: "0.65rem",
                color: "#64748b",
                textAlign: "center",
              }}
            >
              {token.replace("--poka-radius-", "")}
            </code>
            <span
              style={{
                fontSize: "0.65rem",
                color: "#94a3b8",
                textAlign: "center",
              }}
            >
              {value}
            </span>
            <span
              style={{
                fontSize: "0.65rem",
                color: "#94a3b8",
                textAlign: "center",
              }}
            >
              {usage}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof RadiiStories> = {
  title: "Design System/Radii",
  component: RadiiStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
