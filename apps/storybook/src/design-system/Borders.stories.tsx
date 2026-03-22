import type { Meta, StoryObj } from "@storybook/react";

const borders = [
  {
    token: "--poka-border-default",
    value: "#e5e7eb",
    label: "Default",
    usage: "Cards, panels, containers",
  },
  {
    token: "--poka-border-subtle",
    value: "#e2e8f0",
    label: "Subtle",
    usage: "Dividers, inner borders",
  },
  {
    token: "--poka-border-input",
    value: "#d1d5db",
    label: "Input",
    usage: "Text inputs, textareas, buttons",
  },
  {
    token: "--poka-border-focus",
    value: "#2563eb",
    label: "Focus",
    usage: "Focus rings, active inputs",
  },
] as const;

function BorderStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Borders</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        4 border colors from default to focus.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {borders.map(({ token, value, label, usage }) => (
          <div
            key={token}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <div
              style={{
                width: 120,
                height: 48,
                borderRadius: "var(--poka-radius-md)",
                border: `2px solid var(${token})`,
                background: "var(--poka-bg-surface)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                }}
              >
                {label}
              </span>
            </div>
            <div>
              <code
                style={{
                  fontSize: "0.65rem",
                  color: "#64748b",
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
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
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

const meta: Meta<typeof BorderStories> = {
  title: "Design System/Borders",
  component: BorderStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
