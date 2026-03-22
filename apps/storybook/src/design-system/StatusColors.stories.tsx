import type { Meta, StoryObj } from "@storybook/react";

const dotColors = [
  { token: "--poka-color-synced", label: "Synced", value: "#22c55e" },
  { token: "--poka-color-connecting", label: "Connecting", value: "#eab308" },
  { token: "--poka-color-receiving", label: "Receiving", value: "#06b6d4" },
  { token: "--poka-color-offline", label: "Offline", value: "#ef4444" },
  { token: "--poka-color-dirty", label: "Dirty", value: "#f97316" },
  { token: "--poka-color-accent", label: "Accent", value: "#3b82f6" },
] as const;

const surfacePairs = [
  {
    surface: "--poka-surface-warning",
    text: "--poka-on-warning",
    label: "Warning",
    surfaceValue: "#fef3c7",
    textValue: "#92400e",
  },
  {
    surface: "--poka-surface-error",
    text: "--poka-on-error",
    label: "Error",
    surfaceValue: "#fef2f2",
    textValue: "#991b1b",
  },
  {
    surface: "--poka-surface-success",
    text: "--poka-on-success",
    label: "Success",
    surfaceValue: "#f0fdf4",
    textValue: "#166534",
  },
  {
    surface: "--poka-surface-info",
    text: "--poka-on-info",
    label: "Info",
    surfaceValue: "#dbeafe",
    textValue: "#1e40af",
  },
] as const;

function Swatch({ color, size = 32 }: { color: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `var(${color})`,
        border: "1px solid rgba(0,0,0,0.1)",
        flexShrink: 0,
      }}
    />
  );
}

function StatusColorStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Status Colors</h2>

      <h3
        style={{
          fontSize: "0.95rem",
          color: "#64748b",
          marginBottom: "1rem",
        }}
      >
        Dot / Icon Colors
      </h3>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "1.5rem",
        }}
      >
        Used for status dots, icon fills, and foreground text indicating state.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          marginBottom: "2.5rem",
        }}
      >
        {dotColors.map(({ token, label, value }) => (
          <div
            key={token}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <Swatch color={token} />
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  color: "#1a1a1a",
                }}
              >
                {label}
              </div>
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
            </div>
          </div>
        ))}
      </div>

      <h3
        style={{
          fontSize: "0.95rem",
          color: "#64748b",
          marginBottom: "1rem",
        }}
      >
        Surface Pairs
      </h3>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "1.5rem",
        }}
      >
        Background + text pairs for state banners, badges, and alerts. Always
        use the matching pair for accessible contrast.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {surfacePairs.map((pair) => (
          <div
            key={pair.label}
            style={{
              background: `var(${pair.surface})`,
              color: `var(${pair.text})`,
              padding: "0.75rem 1rem",
              borderRadius: "6px",
              fontSize: "0.8rem",
            }}
          >
            <div style={{ fontWeight: 500 }}>{pair.label} surface</div>
            <code style={{ fontSize: "0.65rem" }}>
              {pair.surface} + {pair.text}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof StatusColorStories> = {
  title: "Design System/Status Colors",
  component: StatusColorStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
