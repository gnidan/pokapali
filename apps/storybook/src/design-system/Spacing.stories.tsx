import type { Meta, StoryObj } from "@storybook/react";

const steps = [
  {
    token: "--poka-space-1",
    value: "0.25rem",
    usage: "Tight inner padding, small gaps",
  },
  {
    token: "--poka-space-2",
    value: "0.5rem",
    usage: "Standard inner padding, body gaps",
  },
  {
    token: "--poka-space-3",
    value: "0.75rem",
    usage: "Panel padding, section gaps",
  },
  { token: "--poka-space-4", value: "1rem", usage: "Card padding, major gaps" },
  {
    token: "--poka-space-6",
    value: "1.5rem",
    usage: "Section spacing, large gaps",
  },
] as const;

function SpacingStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Spacing</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        5 steps. Used for padding, gap, and margin. Not every spacing value
        needs a token — only the recurring ones that define rhythm.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        {steps.map(({ token, value, usage }) => (
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
                width: `var(${token})`,
                height: 32,
                background: "var(--poka-color-receiving)",
                borderRadius: 2,
                flexShrink: 0,
                opacity: 0.6,
                minWidth: 4,
              }}
            />
            <div
              style={{
                width: 48,
                height: 32,
                background: "var(--poka-bg-subtle)",
                borderRadius: "var(--poka-radius-md)",
                border: "1px solid var(--poka-border-default)",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontSize: "0.65rem",
                  color: "#64748b",
                }}
              >
                {value}
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

      {/* Padding demo */}
      <h3
        style={{
          fontSize: "0.95rem",
          color: "#64748b",
          marginTop: "2.5rem",
          marginBottom: "1rem",
        }}
      >
        Padding Demo
      </h3>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        {steps.map(({ token, value }) => (
          <div
            key={token}
            style={{
              padding: `var(${token})`,
              background: "var(--poka-bg-surface)",
              border: "1px solid var(--poka-border-default)",
              borderRadius: "var(--poka-radius-md)",
            }}
          >
            <div
              style={{
                background: "var(--poka-surface-info)",
                padding: "0.25rem 0.5rem",
                borderRadius: 3,
                fontSize: "0.65rem",
                color: "var(--poka-on-info)",
                whiteSpace: "nowrap",
              }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof SpacingStories> = {
  title: "Design System/Spacing",
  component: SpacingStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
