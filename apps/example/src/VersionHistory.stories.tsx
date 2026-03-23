import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { Doc, VersionEntry } from "@pokapali/core";
import { VersionHistory } from "./VersionHistory";
import type { VersionHistoryData } from "./useVersionHistory";

// --- Mock data ---

const NOW = Date.now();
const HOUR = 3_600_000;

const mockVersions: VersionEntry[] = [
  {
    cid: "bafyreicurrent" as unknown as VersionEntry["cid"],
    seq: 12,
    ts: NOW - 5_000,
  },
  {
    cid: "bafyreiseq11" as unknown as VersionEntry["cid"],
    seq: 11,
    ts: NOW - 15 * 60_000,
  },
  {
    cid: "bafyreiseq10" as unknown as VersionEntry["cid"],
    seq: 10,
    ts: NOW - HOUR,
    tier: "daily",
  },
  {
    cid: "bafyreiseq9" as unknown as VersionEntry["cid"],
    seq: 9,
    ts: NOW - 3 * HOUR,
  },
  {
    cid: "bafyreiseq8" as unknown as VersionEntry["cid"],
    seq: 8,
    ts: NOW - 6 * HOUR,
  },
  {
    cid: "bafyreiseq7" as unknown as VersionEntry["cid"],
    seq: 7,
    ts: NOW - 12 * HOUR,
    tier: "daily",
  },
  {
    cid: "bafyreiseq5" as unknown as VersionEntry["cid"],
    seq: 5,
    ts: NOW - 48 * HOUR,
  },
  {
    cid: "bafyreiseq3" as unknown as VersionEntry["cid"],
    seq: 3,
    ts: NOW - 96 * HOUR,
  },
];

const mockDeltas = new Map<number, number>([
  [12, 42],
  [11, -8],
  [10, 156],
  [9, 23],
  [8, 0],
  [7, -34],
  [5, 100],
  [3, 50],
]);

function mockHistory(
  overrides?: Partial<VersionHistoryData>,
): VersionHistoryData {
  return {
    versions: mockVersions,
    listState: { status: "idle" },
    versionTexts: new Map(),
    deltas: mockDeltas,
    visibleVersions: mockVersions.filter(
      (v) => (mockDeltas.get(v.seq) ?? 1) !== 0,
    ),
    settling: false,
    ...overrides,
  };
}

function mockDoc(): Doc {
  return {
    tipCid: "bafyreicurrent",
    loadVersion: () => Promise.resolve({ content: null }),
  } as unknown as Doc;
}

// --- Wrapper ---

function VersionHistoryDemo({ history }: { history: VersionHistoryData }) {
  const [closed, setClosed] = useState(false);

  if (closed) {
    return <button onClick={() => setClosed(false)}>Reopen</button>;
  }

  return (
    <div
      style={{
        position: "relative",
        width: 300,
        minHeight: 400,
      }}
    >
      <VersionHistory
        doc={mockDoc()}
        history={history}
        onClose={() => setClosed(true)}
        onPreview={() => {}}
        onClosePreview={() => {}}
      />
    </div>
  );
}

// --- Stories ---

const meta: Meta = {
  title: "Components/VersionHistory",
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => <VersionHistoryDemo history={mockHistory()} />,
};

export const Loading: Story = {
  render: () => (
    <VersionHistoryDemo
      history={mockHistory({
        listState: { status: "loading" },
        versions: [],
        visibleVersions: [],
      })}
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <VersionHistoryDemo
      history={mockHistory({
        versions: [],
        visibleVersions: [],
        deltas: new Map(),
      })}
    />
  ),
};

export const FetchError: Story = {
  render: () => (
    <VersionHistoryDemo
      history={mockHistory({
        listState: {
          status: "error",
          message: "Network timeout",
        },
        versions: [],
        visibleVersions: [],
      })}
    />
  ),
};
