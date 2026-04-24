import { useEffect, useRef, useState } from "react";
import type { Doc, Feed, SnapshotEvent } from "@pokapali/core";

/**
 * Snapshot-exchange diagnostics — Path A.
 *
 * In-browser, dev-only event log for the snapshot-
 * exchange protocol. Renders a chronological feed of
 * arrivals so a developer can answer "are catalogs
 * arriving? are snapshots landing locally or from a
 * peer?"
 *
 * Path A uses only pre-existing core feeds — zero new
 * core work for S54. BLK rows render
 * `(local)`/`(remote)` from `SnapshotEvent.isLocal`
 * rather than via peer attribution; peer attribution
 * + validity markers are deferred to S55+ (the
 * `blockReceivedEvents` feed was briefly pinned as
 * "Tier 0.5" then withdrawn on kaizen grounds).
 *
 * Hard non-goals (see spec
 * `design-snapshot-exchange-diagnostics.md`):
 * - Not telemetry. Local browser only, no phone-home.
 * - Not a logs viewer. Bounded ring, no filters.
 *
 * Vocabulary discriminator includes kinds that don't
 * fire in S54 (`req`, `request-failed`, `timeout`,
 * `fallback`) so forward-compatible test assertions
 * compile today and start matching when S55+ kinds
 * land.
 */
export type ExchangeEventKind =
  | "catalog"
  | "blk"
  | "req"
  | "request-failed"
  | "timeout"
  | "fallback";

/**
 * BLK row locality — Path A sub-discriminator for the
 * `blk` kind. Derived from `SnapshotEvent.isLocal`.
 */
export type ExchangeLocality = "local" | "remote";

/**
 * One row in the diagnostics event log. `seq` is a
 * hook-local monotonic counter used as the React key —
 * unrelated to the protocol's snapshot sequence.
 */
export interface ExchangeEvent {
  seq: number;
  kind: ExchangeEventKind;
  ts: number;
  /** For `catalog`: "N entries". For `blk`: short CID. */
  detail: string;
  /** Set for `blk` rows only (Path A). */
  locality?: ExchangeLocality;
}

const RING_SIZE = 20;

/**
 * Append an event to a newest-first ring buffer,
 * dropping the oldest if over capacity. Pure: returns
 * a new array, does not mutate input.
 *
 * Exported separately from the hook so ring-buffer
 * semantics can be unit-tested without a mounted
 * React tree or a mocked Doc.
 */
export function pushEvent(
  buffer: readonly ExchangeEvent[],
  event: ExchangeEvent,
  size: number = RING_SIZE,
): ExchangeEvent[] {
  const next = [event, ...buffer];
  if (next.length > size) next.length = size;
  return next;
}

/**
 * Format a unix-ms timestamp as a "Ns ago" /
 * "Nm ago" / "Nh ago" string relative to `now`.
 *
 * Distinct from `formatRelativeTime` in
 * `ConnectionStatus.tsx` which formats FUTURE
 * timestamps (returns "expired" for past).
 */
export function formatAgo(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  return `${hrs}h ago`;
}

/** Shape mirrors architect's pinned `CatalogEvent` in
 *  integration-design memo. Declared inline (not
 *  imported from `@pokapali/core`) because A4's
 *  wiring hasn't merged yet. Replace with a core
 *  import once the public surface ships. */
interface CatalogEventShape {
  networkId: string;
  peerId: string;
  entries: ReadonlyArray<{ cid: Uint8Array; seq: number }>;
  tip: Uint8Array | null;
  receivedAt: number;
}

type CatalogFeed = Feed<CatalogEventShape | null>;

/**
 * Subscribe to the snapshot-exchange feeds and
 * accumulate arrivals into a bounded, newest-first
 * ring buffer of `ExchangeEvent`s.
 *
 * Feature-detects `doc.catalogEvents` — pinned by
 * architect but not yet merged at the time this
 * shell lands. `snapshotEvents` is always present.
 *
 * The hook is unconditional (rules of hooks). The
 * `?diag` gate happens in the rendering component.
 */
export function useSnapshotExchangeEvents(doc: Doc): ExchangeEvent[] {
  const [events, setEvents] = useState<ExchangeEvent[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const nextSeq = () => ++seqRef.current;

    // Reset on doc swap so a stale buffer from a prior
    // doc never leaks into a new one.
    setEvents([]);
    seqRef.current = 0;

    const docAny = doc as unknown as {
      catalogEvents?: CatalogFeed;
    };
    const catalogFeed = docAny.catalogEvents;
    const snapshotFeed = doc.snapshotEvents as Feed<SnapshotEvent | null>;

    const unsubs: Array<() => void> = [];

    if (catalogFeed) {
      unsubs.push(
        catalogFeed.subscribe(() => {
          const e = catalogFeed.getSnapshot();
          if (!e) return;
          const entries = e.entries.length;
          setEvents((prev) =>
            pushEvent(prev, {
              seq: nextSeq(),
              kind: "catalog",
              ts: e.receivedAt,
              detail: `${entries} ${entries === 1 ? "entry" : "entries"}`,
            }),
          );
        }),
      );
    }

    unsubs.push(
      snapshotFeed.subscribe(() => {
        const e = snapshotFeed.getSnapshot();
        if (!e) return;
        setEvents((prev) =>
          pushEvent(prev, {
            seq: nextSeq(),
            kind: "blk",
            ts: e.ts,
            detail: truncateCidString(e.cid.toString()),
            locality: e.isLocal ? "local" : "remote",
          }),
        );
      }),
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [doc]);

  return events;
}

/**
 * Local copy of the `truncateCid` visual convention
 * (first6+ellipsis+last6) from `ConnectionStatus.tsx`,
 * prefixed with `#` for the diagnostics row format.
 *
 * Kept local so `snapshotExchangeEvents.ts` stays
 * self-contained; `truncateCid` in ConnectionStatus
 * is exported for future call-sites that want the
 * raw visual without the `#` marker.
 */
function truncateCidString(cid: string): string {
  if (cid.length <= 12) return `#${cid}`;
  return `#${cid.slice(0, 6)}\u2026${cid.slice(-6)}`;
}
