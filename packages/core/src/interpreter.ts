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
  DocStatus,
  SaveState,
  GossipActivity,
} from "./facts.js";
import type { AsyncQueue } from "./sources.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("interpreter");

// ------------------------------------------------
// EffectHandlers — injected dependency
// ------------------------------------------------

export interface EffectHandlers {
  // Block resolution
  fetchBlock(cid: CID): Promise<Uint8Array | null>;
  applySnapshot(cid: CID, block: Uint8Array): Promise<{ seq: number }>;
  getBlock(cid: CID): Uint8Array | null;

  // Decode snapshot metadata (prev, seq, ts, publisher)
  decodeBlock(block: Uint8Array): {
    prev?: CID;
    seq?: number;
    snapshotTs?: number;
    /** Hex-encoded publisher identity pubkey,
     *  if present and signature valid. */
    publisher?: string;
  };

  /** Check if a publisher pubkey is authorized.
   *  Returns true if no auth is configured
   *  (permissionless) or if the pubkey is in
   *  authorizedPublishers. */
  isPublisherAuthorized(publisherHex: string | undefined): boolean;

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
      { guaranteeUntil: number; retainUntil: number }
    >,
  ): void;
  emitStatus(status: DocStatus): void;
  emitSaveState(saveState: SaveState): void;
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

// Track scheduled wake-ups to avoid duplicates
const scheduledWakeups = new WeakMap<
  AsyncQueue<Fact>,
  {
    gossipDecay?: ReturnType<typeof setTimeout>;
    guaranteeRequery?: ReturnType<typeof setTimeout>;
  }
>();

function getTimers(feedback: AsyncQueue<Fact>): {
  gossipDecay?: ReturnType<typeof setTimeout>;
  guaranteeRequery?: ReturnType<typeof setTimeout>;
} {
  let timers = scheduledWakeups.get(feedback);
  if (!timers) {
    timers = {};
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
  if (timers.guaranteeRequery) clearTimeout(timers.guaranteeRequery);
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

export async function runInterpreter(
  stateStream: AsyncIterable<ScanOutput>,
  effects: EffectHandlers,
  feedback: AsyncQueue<Fact>,
  signal: AbortSignal,
): Promise<void> {
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
          // Inline apply — fast, awaited
          const result = await effects.applySnapshot(tipCid, block);
          feedback.push({
            type: "tip-advanced",
            ts: Date.now(),
            cid: tipCid,
            seq: result.seq,
          });
        }
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

    // Status
    if (prev.status !== next.status) {
      effects.emitStatus(next.status);
    }

    // Save state
    if (prev.saveState !== next.saveState) {
      effects.emitSaveState(next.saveState);
    }

    // --- On-demand wake-ups ---
    scheduleWakeups(next, feedback);
  }
}
