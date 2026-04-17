import type { Meta, StoryObj } from "@storybook/react";
import {
  SnapshotExchangeDetailView,
  type SnapshotExchangeDetailViewProps,
} from "./SnapshotExchangeDetail";
import type { ExchangeEvent } from "./snapshotExchangeEvents";

// All stories pin `now` so relative-time formatting
// is deterministic across snapshots and screenshots.
const NOW = 1_000_000_000;

function makeEvent(
  over: Partial<ExchangeEvent> & Pick<ExchangeEvent, "seq">,
): ExchangeEvent {
  return {
    kind: "catalog",
    ts: NOW,
    detail: "1 entry",
    ...over,
  };
}

const meta: Meta<typeof SnapshotExchangeDetailView> = {
  title: "Components/SnapshotExchangeDetail",
  component: SnapshotExchangeDetailView,
};

export default meta;
type Story = StoryObj<typeof meta>;

function defaultProps(
  over?: Partial<SnapshotExchangeDetailViewProps>,
): SnapshotExchangeDetailViewProps {
  return { events: [], now: NOW, ...over };
}

export const Empty: Story = {
  render: () => <SnapshotExchangeDetailView {...defaultProps()} />,
};

export const SingleCatalog: Story = {
  render: () => (
    <SnapshotExchangeDetailView
      {...defaultProps({
        events: [
          makeEvent({
            seq: 1,
            kind: "catalog",
            ts: NOW - 12_000,
            detail: "12 entries",
          }),
        ],
      })}
    />
  ),
};

export const Mixed: Story = {
  render: () => (
    <SnapshotExchangeDetailView
      {...defaultProps({
        events: [
          makeEvent({
            seq: 5,
            kind: "catalog",
            ts: NOW - 2_000,
            detail: "8 entries",
          }),
          makeEvent({
            seq: 4,
            kind: "blk",
            ts: NOW - 5_000,
            detail: "#bafyre\u2026jm4aoi",
            locality: "remote",
          }),
          makeEvent({
            seq: 3,
            kind: "blk",
            ts: NOW - 7_000,
            detail: "#bafyre\u2026jm4aoh",
            locality: "local",
          }),
          makeEvent({
            seq: 2,
            kind: "blk",
            ts: NOW - 8_000,
            detail: "#bafyre\u2026jm4aog",
            locality: "remote",
          }),
          makeEvent({
            seq: 1,
            kind: "catalog",
            ts: NOW - 12_000,
            detail: "12 entries",
          }),
        ],
      })}
    />
  ),
};

export const Full: Story = {
  // Saturated 20-event ring; verifies row density
  // and overflow handling.
  render: () => {
    const events: ExchangeEvent[] = Array.from({ length: 20 }, (_, i) => {
      const seq = 20 - i;
      const ageSec = (i + 1) * 3;
      const isCatalog = seq % 5 === 0;
      const suffix = seq.toString(16).padStart(2, "0");
      return makeEvent({
        seq,
        kind: isCatalog ? "catalog" : "blk",
        ts: NOW - ageSec * 1000,
        detail: isCatalog
          ? `${(seq % 9) + 1} entries`
          : `#bafyre\u2026jm4a${suffix}`,
        locality: isCatalog ? undefined : seq % 3 === 0 ? "local" : "remote",
      });
    });
    return <SnapshotExchangeDetailView {...defaultProps({ events })} />;
  },
};
