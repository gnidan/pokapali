/**
 * Async iteration utilities for the fact-stream
 * architecture: createAsyncQueue, merge, scan, plus
 * source generator factories.
 */

import type { CID } from "multiformats/cid";
import type { Fact } from "./facts.js";

// ── Feed ────────────────────────────────────────

/**
 * Read-only reactive value container compatible with
 * React's useSyncExternalStore.
 */
export interface Feed<T> {
  /** Current value. */
  getSnapshot(): T;
  /** Subscribe to changes. Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
}

/**
 * Internal writable feed. Extends Feed with an
 * _update method for the scan pipeline. Not exported
 * from the package public API.
 */
export interface WritableFeed<T> extends Feed<T> {
  /** Update the value. No-op if equal. */
  _update(value: T): void;
}

/**
 * Create a WritableFeed with an initial value and
 * optional equality function (defaults to ===).
 */
export function createFeed<T>(
  initial: T,
  eq?: (a: T, b: T) => boolean,
): WritableFeed<T> {
  let current = initial;
  const subs = new Set<() => void>();
  const equal = eq ?? ((a, b) => a === b);

  return {
    getSnapshot: () => current,
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    _update(value) {
      if (equal(current, value)) return;
      current = value;
      for (const cb of subs) cb();
    },
  };
}

// ── createAsyncQueue ─────────────────────────────

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
}

/**
 * Bridge push-based callbacks to pull-based async
 * iteration. Values pushed before consumption are
 * buffered. Terminates when signal aborts (after
 * draining any buffered values).
 */
export function createAsyncQueue<T>(signal: AbortSignal): AsyncQueue<T> {
  const buffer: T[] = [];
  let resolve: (() => void) | null = null;
  let done = signal.aborted;

  signal.addEventListener(
    "abort",
    () => {
      done = true;
      if (resolve) resolve();
    },
    { once: true },
  );

  async function* iterate(): AsyncGenerator<T> {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (done) return;
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
  }

  const gen = iterate();

  return {
    push(value: T) {
      if (done) return;
      buffer.push(value);
      if (resolve) resolve();
    },
    [Symbol.asyncIterator]() {
      return gen;
    },
  };
}

// ── merge ────────────────────────────────────────

/**
 * Interleave multiple async iterables into a single
 * stream via Promise.race. No buffering — natural
 * backpressure from `for await`.
 */
export async function* merge<T>(
  ...sources: AsyncIterable<T>[]
): AsyncGenerator<T> {
  const iters = sources.map((s) => s[Symbol.asyncIterator]());
  const pending = new Map<
    number,
    Promise<{ idx: number; result: IteratorResult<T> }>
  >();

  for (let i = 0; i < iters.length; i++) {
    pending.set(
      i,
      iters[i].next().then((result) => ({ idx: i, result })),
    );
  }

  while (pending.size > 0) {
    const { idx, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(idx);
    } else {
      yield result.value;
      pending.set(
        idx,
        iters[idx].next().then((result) => ({ idx, result })),
      );
    }
  }
}

// ── scan ─────────────────────────────────────────

/**
 * Encapsulated fold over an async iterable. Yields
 * `{ prev, next, fact }` after each reduction step.
 * The accumulator `let` lives inside the generator
 * closure — mutation is invisible outside.
 */
export async function* scan<S, F>(
  facts: AsyncIterable<F>,
  reducer: (s: S, f: F) => S,
  init: S,
): AsyncGenerator<{ prev: S; next: S; fact: F }> {
  let s = init;
  for await (const fact of facts) {
    const prev = s;
    s = reducer(s, fact);
    yield { prev, next: s, fact };
  }
}

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
