/**
 * interpreter.ts — The effect interpreter for the
 * fact-stream state management architecture.
 *
 * The ONLY impure code in the system. Consumes the
 * scan output stream, dispatches side effects, and
 * feeds results back into the fact stream.
 */

import type { CID } from "multiformats/cid";
import type {
  Fact,
  DocState,
  ChainEntry,
  CidSource,
  GossipActivity,
} from "./facts.js";
import type { AsyncQueue } from "./sources.js";
import type { SnapshotOps } from "./snapshot-ops.js";
import { SnapshotValidationError } from "./snapshot-ops.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("interpreter");

// Re-export for consumers that import from here.
export type { SnapshotOps } from "./snapshot-ops.js";
export type { BlockMetadata } from "./snapshot-ops.js";

// ------------------------------------------------
// EffectHandlers — injected dependency
// ------------------------------------------------

export interface EffectHandlers extends SnapshotOps {
  // Block resolution
  fetchBlock(cid: CID): Promise<Uint8Array | null>;
  getBlock(cid: CID): Uint8Array | null;

  // Outbound protocol
  announce(cid: CID, block: Uint8Array, seq: number): void;

  // Lifecycle
  markReady(): void;

  // Feed updates (→ Doc facade → consumers)
  emitSnapshotApplied(cid: CID, seq: number): void;
  emitAck(cid: CID, ackedBy: ReadonlySet<string>): void;
  emitGossipActivity(activity: GossipActivity): void;
  emitLoading(phase: string): void;
  emitGuarantee(
    cid: CID,
    guarantees: ReadonlyMap<
      string,
      {
        guaranteeUntil: number;
        retainUntil: number;
      }
    >,
  ): void;
  emitValidationError(info: { cid: string; message: string }): void;

  // Epoch lifecycle (optional — omit for
  // consumers that don't support epochs)
  writeViewCache?(
    channel: string,
    epochIndex: number,
  ): Promise<{ viewName: string; entries: number }[] | void>;
  materializeSnapshot?(
    channel: string,
    epochIndex: number,
  ): Promise<CID | null>;
  populateViewCache?(viewName: string, entries: number): void;
}

// ------------------------------------------------
// Fetch policy
// ------------------------------------------------

const AUTO_FETCH_SOURCES: ReadonlySet<CidSource> = new Set([
  "gossipsub",
  "ipns",
  "http-tip",
  "reannounce",
  "chain-walk",
]);

export function shouldAutoFetch(entry: ChainEntry): boolean {
  for (const src of entry.discoveredVia) {
    if (AUTO_FETCH_SOURCES.has(src)) return true;
  }
  return false;
}

// ------------------------------------------------
// Non-blocking fetch dispatch
// ------------------------------------------------

function dispatchFetch(
  cid: CID,
  entry: ChainEntry,
  effects: EffectHandlers,
  feedback: AsyncQueue<Fact>,
): void {
  feedback.push({
    type: "block-fetch-started",
    ts: Date.now(),
    cid,
  });

  effects
    .fetchBlock(cid)
    .then((block) => {
      if (block) {
        const decoded = effects.decodeBlock(block);
        feedback.push({
          type: "block-fetched",
          ts: Date.now(),
          cid,
          block,
          prev: decoded.prev,
          seq: decoded.seq,
          snapshotTs: decoded.snapshotTs,
        });
      } else {
        feedback.push({
          type: "block-fetch-failed",
          ts: Date.now(),
          cid,
          attempt: entry.fetchAttempt + 1,
          error: "not found",
        });
      }
    })
    .catch((err: unknown) => {
      feedback.push({
        type: "block-fetch-failed",
        ts: Date.now(),
        cid,
        attempt: entry.fetchAttempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

// ------------------------------------------------
// Wake-up scheduling
// ------------------------------------------------

const GOSSIP_DECAY_MS = 60_000;
const GUARANTEE_REQUERY_MS = 5 * 60_000;

/** Max interpreter-level retry attempts before
 *  reporting "failed" to consumers. Each attempt
 *  already includes fetchBlock's internal retries. */
export const MAX_INTERPRETER_RETRIES = 3;

/** Base delay between interpreter retry attempts.
 *  Exponential: BASE * 4^(attempt-1) → 2s, 8s, 32s. */
export const RETRY_BASE_MS = 2_000;

/** Default depth for chain prefetching after
 *  tip-advanced. Set to 0 to disable. */
export const DEFAULT_PREFETCH_DEPTH = 3;

// Track scheduled wake-ups to avoid duplicates
const scheduledWakeups = new WeakMap<
  AsyncQueue<Fact>,
  {
    gossipDecay?: ReturnType<typeof setTimeout>;
    guaranteeRequery?: ReturnType<typeof setTimeout>;
    blockRetries: Map<string, ReturnType<typeof setTimeout>>;
  }
>();

function getTimers(feedback: AsyncQueue<Fact>): {
  gossipDecay?: ReturnType<typeof setTimeout>;
  guaranteeRequery?: ReturnType<typeof setTimeout>;
  blockRetries: Map<string, ReturnType<typeof setTimeout>>;
} {
  let timers = scheduledWakeups.get(feedback);
  if (!timers) {
    timers = { blockRetries: new Map() };
    scheduledWakeups.set(feedback, timers);
  }
  return timers;
}

function scheduleWakeups(state: DocState, feedback: AsyncQueue<Fact>): void {
  const timers = getTimers(feedback);

  // Gossip decay wake-up
  if (state.connectivity.gossip.activity === "receiving") {
    const elapsed = Date.now() - state.connectivity.gossip.lastMessageAt;
    const remaining = GOSSIP_DECAY_MS - elapsed;
    if (remaining > 0 && !timers.gossipDecay) {
      timers.gossipDecay = setTimeout(() => {
        timers.gossipDecay = undefined;
        feedback.push({ type: "tick", ts: Date.now() });
      }, remaining);
    }
  } else if (timers.gossipDecay) {
    clearTimeout(timers.gossipDecay);
    timers.gossipDecay = undefined;
  }

  // Guarantee requery wake-up
  if (state.announce.lastAnnouncedCid) {
    const elapsed = Date.now() - state.announce.lastGuaranteeQueryAt;
    const remaining = GUARANTEE_REQUERY_MS - elapsed;
    if (remaining > 0 && !timers.guaranteeRequery) {
      timers.guaranteeRequery = setTimeout(() => {
        timers.guaranteeRequery = undefined;
        feedback.push({ type: "tick", ts: Date.now() });
      }, remaining);
    }
  }
}

function clearAllWakeups(feedback: AsyncQueue<Fact>): void {
  const timers = scheduledWakeups.get(feedback);
  if (!timers) return;
  if (timers.gossipDecay) clearTimeout(timers.gossipDecay);
  if (timers.guaranteeRequery) {
    clearTimeout(timers.guaranteeRequery);
  }
  for (const t of timers.blockRetries.values()) {
    clearTimeout(t);
  }
  scheduledWakeups.delete(feedback);
}

// ------------------------------------------------
// Main interpreter loop
// ------------------------------------------------

export interface ScanOutput {
  prev: DocState;
  next: DocState;
  fact: Fact;
}

export interface InterpreterOptions {
  /** How many parent blocks to prefetch after
   *  tip-advanced. Default: {@link DEFAULT_PREFETCH_DEPTH}.
   *  Set to 0 to disable. */
  prefetchDepth?: number;
}

export async function runInterpreter(
  stateStream: AsyncIterable<ScanOutput>,
  effects: EffectHandlers,
  feedback: AsyncQueue<Fact>,
  signal: AbortSignal,
  options?: InterpreterOptions,
): Promise<void> {
  const prefetchDepth = options?.prefetchDepth ?? DEFAULT_PREFETCH_DEPTH;
  signal.addEventListener("abort", () => clearAllWakeups(feedback), {
    once: true,
  });

  for await (const { prev, next, fact } of stateStream) {
    if (signal.aborted) break;

    // --- Fetch newly-unknown CIDs ---
    for (const entry of next.chain.entries.values()) {
      if (entry.blockStatus !== "unknown") continue;
      const key = entry.cid.toString();
      const prevEntry = prev.chain.entries.get(key);
      // Only fetch if entry just became unknown
      // (new discovery or retry reset)
      if (prevEntry?.blockStatus === "unknown") continue;
      // Only auto-fetch tip-candidate sources.
      // Exception: cache-sourced entries that are
      // the newest seq get fetched so the editor
      // has its block on reload.
      if (!shouldAutoFetch(entry)) {
        const isNewestCached =
          entry.discoveredVia.has("cache") &&
          entry.seq !== undefined &&
          entry.seq === next.chain.maxSeq;
        if (!isNewestCached) continue;
      }

      // Fast path: if the block is already cached
      // locally (e.g. from a prior publish or
      // loadVersion), skip the async fetch and emit
      // block-fetched immediately. This collapses
      // chain walks to microtask speed for cached
      // blocks, preventing UI flicker.
      const cached = effects.getBlock(entry.cid);
      if (cached) {
        const decoded = effects.decodeBlock(cached);
        feedback.push({
          type: "block-fetched",
          ts: Date.now(),
          cid: entry.cid,
          block: cached,
          prev: decoded.prev,
          seq: decoded.seq,
          snapshotTs: decoded.snapshotTs,
        });
        continue;
      }

      dispatchFetch(entry.cid, entry, effects, feedback);
    }

    // --- Schedule retries for failed blocks ---
    if (fact.type === "block-fetch-failed") {
      const entry = next.chain.entries.get(fact.cid.toString());
      if (entry && entry.fetchAttempt < MAX_INTERPRETER_RETRIES) {
        const timers = getTimers(feedback);
        const key = fact.cid.toString();
        if (!timers.blockRetries.has(key)) {
          const delay = RETRY_BASE_MS * 4 ** (entry.fetchAttempt - 1);
          timers.blockRetries.set(
            key,
            setTimeout(() => {
              timers.blockRetries.delete(key);
              feedback.push({
                type: "block-retry-reset",
                ts: Date.now(),
                cid: fact.cid,
              });
            }, delay),
          );
        }
      }
    }

    // --- Cancel retry timer if block was fetched ---
    if (fact.type === "block-fetched" || fact.type === "tip-advanced") {
      const timers = getTimers(feedback);
      const key = fact.cid.toString();
      const timer = timers.blockRetries.get(key);
      if (timer) {
        clearTimeout(timer);
        timers.blockRetries.delete(key);
      }
    }

    // --- Decode inline blocks for chain discovery ---
    // When cid-discovered arrives with an inline
    // block, the reducer marks it "fetched" but
    // doesn't extract prev/ts. Emit a synthetic
    // block-fetched so the reducer discovers the
    // chain-walk prev link.
    if (fact.type === "cid-discovered" && fact.block) {
      const decoded = effects.decodeBlock(fact.block);
      if (decoded.prev || decoded.snapshotTs) {
        feedback.push({
          type: "block-fetched",
          ts: Date.now(),
          cid: fact.cid,
          block: fact.block,
          prev: decoded.prev,
          seq: decoded.seq,
          snapshotTs: decoded.snapshotTs,
        });
      }
    }

    // --- Apply newest fetched CID as tip ---
    const tipCid = next.chain.newestFetched;
    if (tipCid && next.chain.applying === null && tipCid !== next.chain.tip) {
      const tipKey = tipCid.toString();
      const prevEntry = prev.chain.entries.get(tipKey);
      // Only apply if this entry just became "fetched"
      if (prevEntry?.blockStatus !== "fetched") {
        const block = effects.getBlock(tipCid);
        if (block) {
          // Authorization check: verify publisher
          // is allowed BEFORE applying.
          const decoded = effects.decodeBlock(block);
          if (!effects.isPublisherAuthorized(decoded.publisher)) {
            // Unauthorized publisher — skip apply.
            // The block stays "fetched" but never
            // becomes the tip.
            continue;
          }
          // Inline apply — fast, awaited.
          // Validation happens inside applySnapshot;
          // catch SnapshotValidationError to skip
          // invalid blocks without crashing the doc.
          try {
            const result = await effects.applySnapshot(tipCid, block);
            feedback.push({
              type: "tip-advanced",
              ts: Date.now(),
              cid: tipCid,
              seq: result.seq,
            });
          } catch (err) {
            if (err instanceof SnapshotValidationError) {
              log.warn("skipping invalid snapshot:", err.message);
              effects.emitValidationError({
                cid: err.cid,
                message: err.message,
              });
            } else {
              throw err;
            }
          }
        }
      }
    }

    // --- Prefetch parent blocks after tip-advanced ---
    // Walk prev links from the new tip to dispatch
    // fetches for parent blocks that haven't been
    // fetched yet. This catches pinner-index and
    // cache-sourced entries that shouldAutoFetch
    // would skip, and avoids waiting for each block
    // to decode before discovering the next.
    if (fact.type === "tip-advanced" && prefetchDepth > 0) {
      let walkCid: CID | undefined = fact.cid;
      let remaining = prefetchDepth;
      while (walkCid && remaining > 0) {
        const walkEntry = next.chain.entries.get(walkCid.toString());
        if (!walkEntry?.prev) break;
        const prevCid = walkEntry.prev;
        const prevEntry = next.chain.entries.get(prevCid.toString());
        if (
          prevEntry &&
          prevEntry.blockStatus === "unknown" &&
          !effects.getBlock(prevCid)
        ) {
          dispatchFetch(prevCid, prevEntry, effects, feedback);
        }
        walkCid = prevCid;
        remaining--;
      }
    }

    // --- publish-succeeded → announce ---
    if (fact.type === "publish-succeeded") {
      const block = effects.getBlock(fact.cid);
      if (block) {
        effects.announce(fact.cid, block, fact.seq);
        feedback.push({
          type: "announced",
          ts: Date.now(),
          cid: fact.cid,
          seq: fact.seq,
        });
      } else {
        log.warn(
          "announce skipped: block not cached",
          fact.cid.toString().slice(0, 16) + "...",
        );
      }
    }

    // --- Reannounce on tick ---
    if (fact.type === "reannounce-tick" && next.announce.lastAnnouncedCid) {
      const cid = next.announce.lastAnnouncedCid;
      const block = effects.getBlock(cid);
      if (block) {
        const entry = next.chain.entries.get(cid.toString());
        effects.announce(cid, block, entry?.seq ?? 0);
        feedback.push({
          type: "announced",
          ts: Date.now(),
          cid,
          seq: entry?.seq ?? 0,
        });
      } else {
        log.warn(
          "reannounce skipped: block not cached",
          cid.toString().slice(0, 16) + "...",
        );
      }
    }

    // --- Relay connect → immediate reannounce ---
    if (fact.type === "relay-connected" && next.announce.lastAnnouncedCid) {
      const cid = next.announce.lastAnnouncedCid;
      const block = effects.getBlock(cid);
      if (block) {
        const entry = next.chain.entries.get(cid.toString());
        effects.announce(cid, block, entry?.seq ?? 0);
      } else {
        log.warn(
          "relay-connect announce skipped:" + " block not cached",
          cid.toString().slice(0, 16) + "...",
        );
      }
    }

    // --- Lifecycle: ready() ---
    if (prev.chain.tip === null && next.chain.tip !== null) {
      effects.markReady();
    }

    // --- Feed updates (emit on change) ---

    // Tip advanced
    if (next.chain.tip !== prev.chain.tip && next.chain.tip) {
      const entry = next.chain.entries.get(next.chain.tip.toString());
      effects.emitSnapshotApplied(next.chain.tip, entry?.seq ?? 0);
    }

    // Per-CID ack changes → emit for tip
    if (next.chain.tip) {
      const tipKey = next.chain.tip.toString();
      const prevAcks = prev.chain.entries.get(tipKey)?.ackedBy;
      const nextAcks = next.chain.entries.get(tipKey)?.ackedBy;
      if (nextAcks && nextAcks !== prevAcks) {
        effects.emitAck(next.chain.tip, nextAcks);
      }
    }

    // Per-CID guarantee changes → emit for tip
    if (next.chain.tip) {
      const tipKey = next.chain.tip.toString();
      const prevG = prev.chain.entries.get(tipKey)?.guarantees;
      const nextG = next.chain.entries.get(tipKey)?.guarantees;
      if (nextG && nextG !== prevG) {
        effects.emitGuarantee(next.chain.tip, nextG);
      }
    }

    // Gossip activity
    if (
      prev.connectivity.gossip.activity !== next.connectivity.gossip.activity
    ) {
      effects.emitGossipActivity(next.connectivity.gossip.activity);
    }

    // --- Epoch lifecycle ---

    // convergence-detected → dispatch epoch-closed
    if (fact.type === "convergence-detected") {
      const ch = next.epochs.channels[fact.channel];
      feedback.push({
        type: "epoch-closed",
        ts: Date.now(),
        channel: fact.channel,
        epochIndex: ch?.openEpochCount ?? 0,
      });
    }

    // epoch-closed → write view cache + materialize
    if (fact.type === "epoch-closed") {
      if (effects.writeViewCache) {
        effects
          .writeViewCache(fact.channel, fact.epochIndex)
          .then((results) => {
            if (!results) return;
            for (const r of results) {
              feedback.push({
                type: "view-cache-written",
                ts: Date.now(),
                viewName: r.viewName,
                entries: r.entries,
              });
            }
          })
          .catch((err: unknown) => {
            log.warn(
              "writeViewCache failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
      }

      if (effects.materializeSnapshot) {
        effects
          .materializeSnapshot(fact.channel, fact.epochIndex)
          .then((cid) => {
            if (cid) {
              feedback.push({
                type: "snapshot-materialized",
                ts: Date.now(),
                channel: fact.channel,
                epochIndex: fact.epochIndex,
                cid,
              });
            }
          })
          .catch((err: unknown) => {
            log.warn(
              "materializeSnapshot failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
      }
    }

    // snapshot-materialized → announce
    if (fact.type === "snapshot-materialized") {
      const block = effects.getBlock(fact.cid);
      if (block) {
        effects.announce(fact.cid, block, fact.epochIndex);
      } else {
        log.warn(
          "snapshot announce skipped:" + " block not cached",
          fact.cid.toString().slice(0, 16) + "...",
        );
      }
    }

    // view-cache-loaded → populate caches
    if (fact.type === "view-cache-loaded") {
      effects.populateViewCache?.(fact.viewName, fact.entries);
    }

    // --- On-demand wake-ups ---
    scheduleWakeups(next, feedback);
  }
}
