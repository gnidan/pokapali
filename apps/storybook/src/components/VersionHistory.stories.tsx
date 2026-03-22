import type { Meta, StoryObj } from "@storybook/react";
import { relativeAge } from "../helpers/story-helpers";

/**
 * Inline VersionHistory story — renders the drawer
 * and version list items using the same CSS classes
 * as the real component. The actual VersionHistory
 * depends on Doc + VersionHistoryData which require
 * deep P2P mocking, so we render the visual structure
 * with static mock data.
 */

const NOW = Date.now();
const HOUR = 3_600_000;

interface MockVersion {
  seq: number;
  ts: number;
  delta?: number;
  status?: "archived" | "unavailable" | null;
  tier?: string;
  expiresAt?: number;
  current?: boolean;
  selected?: boolean;
}

function VersionItem({
  seq,
  ts,
  delta,
  status,
  tier,
  current,
  selected,
}: MockVersion) {
  return (
    <button
      className={
        "vh-item" +
        (selected ? " selected" : "") +
        (status === "archived" ? " archived" : "") +
        (status === "unavailable" ? " unavailable" : "")
      }
      disabled={status != null}
    >
      <span className="vh-item-seq">
        #{seq}
        {current && <span className="vh-current-badge">current</span>}
      </span>
      {delta !== undefined && (
        <span
          className={
            "vh-item-delta" +
            (delta > 0 ? " added" : delta < 0 ? " removed" : " unchanged")
          }
        >
          {delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "\u00b10"}
        </span>
      )}
      <span className="vh-item-ts">{relativeAge(ts)}</span>
      {tier && tier !== "tip" && (
        <span className={"vh-item-retention vh-tier-" + tier}>{tier}</span>
      )}
    </button>
  );
}

const versions: MockVersion[] = [
  {
    seq: 12,
    ts: NOW - 5_000,
    delta: 42,
    current: true,
    selected: true,
  },
  { seq: 11, ts: NOW - 15 * 60_000, delta: -8 },
  {
    seq: 10,
    ts: NOW - HOUR,
    delta: 156,
    tier: "guaranteed",
  },
  { seq: 9, ts: NOW - 3 * HOUR, delta: 23 },
  { seq: 8, ts: NOW - 6 * HOUR, delta: 0 },
  {
    seq: 7,
    ts: NOW - 12 * HOUR,
    delta: -34,
    tier: "guaranteed",
  },
  {
    seq: 5,
    ts: NOW - 48 * HOUR,
    status: "archived",
  },
  {
    seq: 3,
    ts: NOW - 96 * HOUR,
    status: "unavailable",
  },
];

function VersionHistoryStories() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>VersionHistory</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "1rem",
        }}
      >
        Right-side drawer showing document version timeline. Each entry shows
        sequence number, delta (characters added/removed), age, and retention
        tier. Archived and unavailable versions are disabled.
      </p>

      <div
        style={{
          display: "flex",
          gap: "2rem",
          alignItems: "start",
        }}
      >
        {/* Full drawer */}
        <div
          className="vh-drawer"
          style={{
            position: "relative",
            width: 300,
            maxHeight: 500,
            border: "1px solid var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            overflow: "hidden",
          }}
        >
          <div className="vh-header">
            <h3>Version history</h3>
            <button className="vh-close" aria-label="Close">
              &#x2715;
            </button>
          </div>
          <div
            className="vh-list-section"
            style={{ maxHeight: 400, overflow: "auto" }}
          >
            {versions.map((v) => (
              <VersionItem key={v.seq} {...v} />
            ))}
          </div>
        </div>

        {/* Individual states */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <h3
            style={{
              fontSize: "var(--poka-text-sm)",
              color: "var(--poka-text-secondary)",
              marginBottom: "0.25rem",
            }}
          >
            Item states
          </h3>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              Current + selected
            </code>
            <VersionItem
              seq={12}
              ts={NOW - 5_000}
              delta={42}
              current={true}
              selected={true}
            />
          </div>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              Positive delta
            </code>
            <VersionItem seq={10} ts={NOW - HOUR} delta={156} />
          </div>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              Negative delta
            </code>
            <VersionItem seq={7} ts={NOW - 12 * HOUR} delta={-34} />
          </div>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              Archived (disabled)
            </code>
            <VersionItem seq={5} ts={NOW - 48 * HOUR} status="archived" />
          </div>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              Unavailable (disabled)
            </code>
            <VersionItem seq={3} ts={NOW - 96 * HOUR} status="unavailable" />
          </div>

          <div>
            <code
              style={{
                fontSize: "var(--poka-text-2xs)",
                color: "var(--poka-text-muted)",
                display: "block",
                marginBottom: "0.25rem",
              }}
            >
              With retention tier
            </code>
            <VersionItem
              seq={10}
              ts={NOW - HOUR}
              delta={156}
              tier="guaranteed"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof VersionHistoryStories> = {
  title: "Components/VersionHistory",
  component: VersionHistoryStories,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
