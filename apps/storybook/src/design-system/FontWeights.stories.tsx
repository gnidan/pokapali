import type { Meta, StoryObj } from "@storybook/react";

const weights = [
  {
    token: "--poka-weight-normal",
    value: "400",
    label: "Normal",
    usage: "Body text, default",
  },
  {
    token: "--poka-weight-medium",
    value: "500",
    label: "Medium",
    usage: "Indicators, labels, buttons",
  },
  {
    token: "--poka-weight-semibold",
    value: "600",
    label: "Semibold",
    usage: "Headings, emphasis",
  },
] as const;

function FontWeightStories() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Font Weights</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "2rem",
        }}
      >
        3 levels. Merges the previous 4 (400/500/600/ 700) — the 700 was only
        used in 3 places and the visual difference from 600 is minimal.
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2rem",
        }}
      >
        {weights.map(({ token, value, label, usage }) => (
          <div key={token}>
            <div
              style={{
                fontSize: "var(--poka-text-base)",
                fontWeight: `var(${token})` as unknown as number,
                color: "var(--poka-text-primary)",
                marginBottom: "0.25rem",
              }}
            >
              The quick brown fox jumps over the lazy dog
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  color: "#1a1a1a",
                  minWidth: 80,
                }}
              >
                {label}
              </span>
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
                }}
              >
                {value}
              </span>
              <span
                style={{
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                }}
              >
                — {usage}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Comparison at different sizes */}
      <h3
        style={{
          fontSize: "0.95rem",
          color: "#64748b",
          marginTop: "2.5rem",
          marginBottom: "1rem",
        }}
      >
        Weight × Size Matrix
      </h3>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "0.8rem",
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                textAlign: "left",
                padding: "0.5rem 1rem 0.5rem 0",
                color: "#64748b",
                fontWeight: 500,
                borderBottom: "1px solid var(--poka-border-subtle)",
              }}
            >
              Size
            </th>
            {weights.map(({ label }) => (
              <th
                key={label}
                style={{
                  textAlign: "left",
                  padding: "0.5rem 1.5rem 0.5rem 0",
                  color: "#64748b",
                  fontWeight: 500,
                  borderBottom: "1px solid var(--poka-border-subtle)",
                }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(
            ["--poka-text-xs", "--poka-text-sm", "--poka-text-base"] as const
          ).map((size) => (
            <tr key={size}>
              <td
                style={{
                  padding: "0.5rem 1rem 0.5rem 0",
                  color: "#94a3b8",
                  fontSize: "0.65rem",
                  fontFamily: "monospace",
                }}
              >
                {size.replace("--poka-text-", "")}
              </td>
              {weights.map(({ token }) => (
                <td
                  key={token}
                  style={{
                    padding: "0.5rem 1.5rem 0.5rem 0",
                    fontSize: `var(${size})`,
                    fontWeight: `var(${token})` as unknown as number,
                    color: "var(--poka-text-primary)",
                  }}
                >
                  Sample
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const meta: Meta<typeof FontWeightStories> = {
  title: "Design System/Font Weights",
  component: FontWeightStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
