import type { Meta, StoryObj } from "@storybook/react";

const backgrounds = [
  {
    token: "--poka-bg-page",
    value: "#fafafa",
    label: "Page",
    usage: "Body background",
  },
  {
    token: "--poka-bg-surface",
    value: "#ffffff",
    label: "Surface",
    usage: "Cards, panels, popovers",
  },
  {
    token: "--poka-bg-muted",
    value: "#f8fafc",
    label: "Muted",
    usage: "Hover states, subtle backgrounds",
  },
  {
    token: "--poka-bg-subtle",
    value: "#f1f5f9",
    label: "Subtle",
    usage: "Pills, secondary buttons",
  },
] as const;

function BackgroundStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Backgrounds</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        4 levels from page to subtle. Nested cards show how surfaces layer.
      </p>

      {/* Nested demo */}
      <div
        style={{
          background: "var(--poka-bg-page)",
          padding: "1.5rem",
          borderRadius: "8px",
          border: "1px solid var(--poka-border-default)",
          marginBottom: "2rem",
        }}
      >
        <div
          style={{
            fontSize: "0.65rem",
            color: "#94a3b8",
            marginBottom: "0.5rem",
          }}
        >
          --poka-bg-page
        </div>
        <div
          style={{
            background: "var(--poka-bg-surface)",
            padding: "1rem",
            borderRadius: "6px",
            border: "1px solid var(--poka-border-default)",
          }}
        >
          <div
            style={{
              fontSize: "0.65rem",
              color: "#94a3b8",
              marginBottom: "0.5rem",
            }}
          >
            --poka-bg-surface
          </div>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                background: "var(--poka-bg-muted)",
                padding: "0.75rem",
                borderRadius: "6px",
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                }}
              >
                --poka-bg-muted
              </div>
            </div>
            <div
              style={{
                background: "var(--poka-bg-subtle)",
                padding: "0.75rem",
                borderRadius: "6px",
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                }}
              >
                --poka-bg-subtle
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Swatch list */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {backgrounds.map(({ token, value, label, usage }) => (
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
                width: 48,
                height: 32,
                borderRadius: 4,
                background: `var(${token})`,
                border: "1px solid rgba(0,0,0,0.1)",
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

const meta: Meta<typeof BackgroundStories> = {
  title: "Design System/Backgrounds",
  component: BackgroundStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
