import type { Meta, StoryObj } from "@storybook/react";
import {
  type MockVersion,
  VersionItem,
  VersionDrawer,
} from "../helpers/mock-version-history";

const NOW = Date.now();
const HOUR = 3_600_000;

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

const meta: Meta = {
  title: "Components/VersionHistory",
};

export default meta;
type Story = StoryObj;

export const FullDrawer: Story = {
  render: () => (
    <VersionDrawer>
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
          <VersionItem
            key={v.seq}
            v={v}
            isSelected={v.selected}
            isCurrent={v.current}
          />
        ))}
      </div>
    </VersionDrawer>
  ),
};

export const CurrentSelected: Story = {
  render: () => (
    <VersionItem
      v={{
        seq: 12,
        ts: NOW - 5_000,
        delta: 42,
      }}
      isCurrent
      isSelected
    />
  ),
};

export const PositiveDelta: Story = {
  render: () => <VersionItem v={{ seq: 10, ts: NOW - HOUR, delta: 156 }} />,
};

export const NegativeDelta: Story = {
  render: () => (
    <VersionItem
      v={{
        seq: 7,
        ts: NOW - 12 * HOUR,
        delta: -34,
      }}
    />
  ),
};

export const Archived: Story = {
  render: () => (
    <VersionItem
      v={{
        seq: 5,
        ts: NOW - 48 * HOUR,
        status: "archived",
      }}
    />
  ),
};

export const Unavailable: Story = {
  render: () => (
    <VersionItem
      v={{
        seq: 3,
        ts: NOW - 96 * HOUR,
        status: "unavailable",
      }}
    />
  ),
};

export const WithRetentionTier: Story = {
  render: () => (
    <VersionItem
      v={{
        seq: 10,
        ts: NOW - HOUR,
        delta: 156,
        tier: "guaranteed",
      }}
    />
  ),
};
