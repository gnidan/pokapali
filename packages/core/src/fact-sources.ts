/**
 * fact-sources.ts — Domain-specific async generators
 * that produce interpreter facts.
 *
 * Each generator yields typed Fact subtypes for the
 * interpreter pipeline.
 */

import type { CID } from "multiformats/cid";
import type { Fact } from "./facts.js";
import { createAsyncQueue } from "./async-utils.js";

// ── delay (abort-aware) ──────────────────────────

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ── reannounceFacts ──────────────────────────────

/**
 * Fixed-interval heartbeat source. Writers must
 * announce even with zero incoming facts, or the CID
 * disappears from the GossipSub mesh.
 */
export async function* reannounceFacts(
  intervalMs: number,
  signal: AbortSignal,
): AsyncGenerator<Extract<Fact, { type: "reannounce-tick" }>> {
  while (!signal.aborted) {
    await abortableDelay(intervalMs, signal);
    if (signal.aborted) return;
    yield { type: "reannounce-tick", ts: Date.now() };
  }
}

// ── ipnsFacts ────────────────────────────────────

/**
 * Poll-based IPNS resolution source. Yields
 * cid-discovered facts when the poll returns a CID.
 */
export async function* ipnsFacts(
  poll: () => Promise<CID | null>,
  intervalMs: number,
  signal: AbortSignal,
): AsyncGenerator<Extract<Fact, { type: "cid-discovered" }>> {
  while (!signal.aborted) {
    await abortableDelay(intervalMs, signal);
    if (signal.aborted) return;
    const cid = await poll();
    if (cid) {
      yield {
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "ipns",
      };
    }
  }
}

// ── eventFacts ───────────────────────────────────

/**
 * Generic event-to-fact bridge. Subscribes to an
 * event source, maps each event to a fact, and
 * cleans up on abort.
 *
 * All domain-specific event sources (gossip,
 * nodeChange, sync, awareness, content) use this
 * pattern.
 */
export function eventFacts<E, F>(
  subscribe: (cb: (event: E) => void) => void,
  unsubscribe: (cb: (event: E) => void) => void,
  mapper: (event: E) => F,
  signal: AbortSignal,
): AsyncIterable<F> {
  const queue = createAsyncQueue<F>(signal);

  const handler = (event: E) => {
    queue.push(mapper(event));
  };

  subscribe(handler);
  signal.addEventListener("abort", () => unsubscribe(handler), { once: true });

  return queue;
}
