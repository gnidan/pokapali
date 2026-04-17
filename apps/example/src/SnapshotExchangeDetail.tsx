import { useEffect, useState } from "react";
import type { Doc } from "@pokapali/core";
import {
  formatAgo,
  useSnapshotExchangeEvents,
  type ExchangeEvent,
} from "./snapshotExchangeEvents";

/**
 * Snapshot-exchange diagnostics view (Path A).
 *
 * Presentational component — pure render of an
 * `ExchangeEvent[]`. Container `SnapshotExchangeDetail`
 * supplies the events and the gating decision.
 */
export interface SnapshotExchangeDetailViewProps {
  events: readonly ExchangeEvent[];
  /** Injected for stable test/story rendering. */
  now?: number;
}

function rowLabel(e: ExchangeEvent): string {
  if (e.kind === "blk") {
    return e.locality === "local" ? "BLK (local)" : "BLK (remote)";
  }
  if (e.kind === "catalog") return "catalog";
  // Forward-compatible S55+ kinds — rendered verbatim
  // if they ever fire in Path A (they won't in S54).
  return e.kind;
}

/** Left-gutter glyph: arrow for incoming events, middle
 *  dot for local author activity. Decorative only. */
function rowPrefix(e: ExchangeEvent): string {
  if (e.kind === "blk" && e.locality === "local") return "\u00b7";
  return "\u2190";
}

export function SnapshotExchangeDetailView({
  events,
  now,
}: SnapshotExchangeDetailViewProps) {
  // Tick once every 5s so "Ns ago" labels stay
  // roughly accurate during quiet periods. Prop
  // override (`now`) lets stories render
  // deterministically.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [now]);
  const currentNow = now ?? tick;

  return (
    <div
      className="cs-detail-section cs-snapshot-exchange"
      data-testid="snapshot-exchange-panel"
    >
      <div className="cs-detail-heading">Snapshot exchange</div>
      {events.length === 0 ? (
        <div
          className="cs-snapshot-exchange-empty"
          data-testid="snapshot-exchange-empty"
        >
          No exchange activity yet
        </div>
      ) : (
        <div
          className="cs-snapshot-exchange-list"
          data-testid="snapshot-exchange-activity"
          role="log"
          aria-live="polite"
          aria-label="Snapshot exchange activity"
        >
          {events.map((e) => (
            <div
              key={e.seq}
              className="cs-snapshot-exchange-row"
              data-testid="snapshot-exchange-event"
              data-kind={e.kind}
              data-locality={e.locality ?? ""}
            >
              <span className="cs-sx-time">{formatAgo(e.ts, currentNow)}</span>
              <span className="cs-sx-arrow" aria-hidden="true">
                {rowPrefix(e)}
              </span>
              <span className="cs-sx-kind">{rowLabel(e)}</span>
              <span className="cs-sx-detail">{e.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Container — subscribes the doc's exchange feeds and
 * passes events to the presentational view. Caller
 * is responsible for the `?diag` gate (see
 * `isDiagEnabled` in `snapshotExchangeEvents.ts`).
 */
export function SnapshotExchangeDetail({ doc }: { doc: Doc }) {
  const events = useSnapshotExchangeEvents(doc);
  return <SnapshotExchangeDetailView events={events} />;
}
