/**
 * shadow-interpreter.ts — Runs the new fact-stream
 * interpreter in parallel with snapshot-watcher for
 * validation. Compares state and logs discrepancies.
 *
 * Shadow mode: the interpreter's output is READ-ONLY.
 * Snapshot-watcher remains the source of truth.
 */

import { CID } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import { decodeSnapshot } from "@pokapali/snapshot";
import {
  announceTopic,
  parseAnnouncement,
  parseGuaranteeResponse,
  base64ToUint8,
} from "./announce.js";
import { createAsyncQueue, scan } from "./sources.js";
import { reduce } from "./reducers.js";
import { initialDocState, bestGuarantee } from "./facts.js";
import type {
  Fact,
  DocState,
  DocRole,
  DocStatus,
  SaveState,
  GossipActivity,
} from "./facts.js";
import { runInterpreter, type EffectHandlers } from "./interpreter.js";
import type { SnapshotWatcher } from "./snapshot-watcher.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("shadow-interpreter");

const DEBOUNCE_MS = 500;

// ── Comparison types ─────────────────────────────

/** Shared shape for old/new system state. */
export interface SystemState {
  status: DocStatus;
  saveState: SaveState;
  ackedBy: ReadonlySet<string>;
  guaranteeUntil: number;
  retainUntil: number;
  gossipActivity: GossipActivity;
  tipCid: string | null;
}

export interface Discrepancy {
  field: string;
  old: unknown;
  new: unknown;
}

// ── Dependencies ─────────────────────────────────

export interface ShadowDeps {
  pubsub: PubSubLike;
  appId: string;
  ipnsName: string;
  role: DocRole;
  channels: string[];
  /** Read-only block access from snapshotLC. */
  getBlock: (cid: CID) => Uint8Array | null;
  snapshotWatcher: SnapshotWatcher;
  /** Current status from create-doc. */
  getStatus: () => DocStatus;
  /** Current saveState from create-doc. */
  getSaveState: () => SaveState;
}

export interface ShadowInterpreter {
  pushFact(fact: Fact): void;
  destroy(): void;
}

export function createShadowInterpreter(deps: ShadowDeps): ShadowInterpreter {
  const ac = new AbortController();
  const { signal } = ac;
  const { pubsub, appId, ipnsName, snapshotWatcher } = deps;

  // --- Fact queue (feedback + external facts) ---
  const factQueue = createAsyncQueue<Fact>(signal);

  // --- GossipSub fact bridge ---
  const topic = announceTopic(appId);

  const gossipHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;

    // Always push gossip-message for liveness
    factQueue.push({
      type: "gossip-message",
      ts: Date.now(),
    });

    // Check guarantee response first
    const gResp = parseGuaranteeResponse(detail.data);
    if (gResp && gResp.ipnsName === ipnsName) {
      try {
        factQueue.push({
          type: "guarantee-received",
          ts: Date.now(),
          peerId: gResp.peerId,
          cid: CID.parse(gResp.cid),
          guaranteeUntil: gResp.guaranteeUntil ?? 0,
          retainUntil: gResp.retainUntil ?? 0,
        });
      } catch {
        // CID parse failure — skip
      }
      return;
    }

    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;

    // Ack handling
    if (ann.ack) {
      try {
        factQueue.push({
          type: "ack-received",
          ts: Date.now(),
          cid: CID.parse(ann.cid),
          peerId: ann.ack.peerId,
        });
      } catch {
        // CID parse failure — skip
      }
      if (
        ann.ack.guaranteeUntil !== undefined ||
        ann.ack.retainUntil !== undefined
      ) {
        try {
          factQueue.push({
            type: "guarantee-received",
            ts: Date.now(),
            peerId: ann.ack.peerId,
            cid: CID.parse(ann.cid),
            guaranteeUntil: ann.ack.guaranteeUntil ?? 0,
            retainUntil: ann.ack.retainUntil ?? 0,
          });
        } catch {
          // CID parse failure — skip
        }
      }
    }

    // CID discovery from announcement
    try {
      const cid = CID.parse(ann.cid);
      let block: Uint8Array | undefined;
      if (ann.block) {
        try {
          block = base64ToUint8(ann.block);
        } catch {
          // decode failure — skip inline block
        }
      }
      factQueue.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "gossipsub",
        block,
        seq: ann.seq,
      });
    } catch {
      // CID parse failure — skip
    }
  };

  pubsub.addEventListener("message", gossipHandler as EventListener);

  // --- Scan pipeline ---
  const init = initialDocState({
    ipnsName,
    role: deps.role,
    channels: deps.channels,
    appId,
  });

  const stateStream = scan(factQueue, reduce, init);

  // --- Shadow effect handlers ---
  // getBlock is real (read-only). fetchBlock is
  // blockstore-only (no HTTP) to avoid doubling
  // network traffic. applySnapshot decodes the block
  // to extract real seq without applying Yjs updates.
  let latestState: DocState = init;

  /** Decode snapshot envelope for prev/seq. */
  function realDecodeBlock(block: Uint8Array): { prev?: CID; seq?: number } {
    try {
      const node = decodeSnapshot(block);
      return {
        prev: node.prev ?? undefined,
        seq: node.seq,
      };
    } catch {
      return {};
    }
  }

  const effects: EffectHandlers = {
    // Blockstore-only: only see blocks that
    // snapshot-watcher already fetched.
    fetchBlock: async (cid) => {
      return deps.getBlock(cid);
    },
    getBlock: deps.getBlock,
    applySnapshot: async (_cid, block) => {
      const decoded = realDecodeBlock(block);
      return { seq: decoded.seq ?? 0 };
    },
    decodeBlock: realDecodeBlock,
    announce: () => {},
    markReady: () => {},
    emitSnapshotApplied: () => {},
    emitAck: () => {},
    emitGossipActivity: () => {},
    emitLoading: () => {},
    emitGuarantee: () => {},
    emitStatus: () => {},
    emitSaveState: () => {},
  };

  // --- State capture + debounced comparison ---
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function* captureState(
    stream: AsyncIterable<{
      prev: DocState;
      next: DocState;
      fact: Fact;
    }>,
  ) {
    for await (const item of stream) {
      latestState = item.next;
      // Debounce comparison to avoid transient
      // mismatch spam during rapid state changes.
      if (!debounceTimer) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (!signal.aborted) {
            runComparison();
          }
        }, DEBOUNCE_MS);
      }
      yield item;
    }
  }

  // --- Start interpreter ---
  runInterpreter(captureState(stateStream), effects, factQueue, signal).catch(
    (err) => {
      if (!signal.aborted) {
        log.warn("shadow interpreter error:", err);
      }
    },
  );

  // --- Comparison ---
  function runComparison() {
    const oldState = projectOldState(
      deps.getStatus(),
      deps.getSaveState(),
      snapshotWatcher,
    );
    const newState = projectNewState(latestState);
    const discrepancies = compareShadowState(oldState, newState);
    for (const d of discrepancies) {
      log.warn(
        `SHADOW MISMATCH ${d.field}:` +
          ` old=${formatValue(d.old)}` +
          ` new=${formatValue(d.new)}`,
      );
    }
  }

  // --- Cleanup ---
  function destroy() {
    ac.abort();
    if (debounceTimer) clearTimeout(debounceTimer);
    pubsub.removeEventListener("message", gossipHandler as EventListener);
  }

  return {
    pushFact(fact: Fact) {
      if (!signal.aborted) {
        factQueue.push(fact);
      }
    },
    destroy,
  };
}

// ── Projections ──────────────────────────────────

function projectOldState(
  status: DocStatus,
  saveState: SaveState,
  watcher: SnapshotWatcher,
): SystemState {
  return {
    status,
    saveState,
    ackedBy: watcher.ackedBy,
    guaranteeUntil: watcher.guaranteeUntil ?? 0,
    retainUntil: watcher.retainUntil ?? 0,
    gossipActivity: watcher.gossipActivity,
    tipCid: null, // snapshot-watcher doesn't expose
  };
}

function projectNewState(state: DocState): SystemState {
  const tip = state.chain.tip;
  const tipKey = tip?.toString() ?? null;
  const entry = tipKey ? state.chain.entries.get(tipKey) : undefined;
  const g = bestGuarantee(state.chain);

  return {
    status: state.status,
    saveState: state.saveState,
    ackedBy: entry?.ackedBy ?? new Set(),
    guaranteeUntil: g.guaranteeUntil,
    retainUntil: g.retainUntil,
    gossipActivity: state.connectivity.gossip.activity,
    tipCid: tipKey,
  };
}

// ── Comparison ───────────────────────────────────

/**
 * Compare old (snapshot-watcher) and new (fact-stream)
 * system state. Returns array of discrepancies.
 *
 * Intentionally skips: fetchAttempt counts,
 * timestamps, pendingQueries, announce state,
 * IPNS resolution status, tipCid (snapshot-watcher
 * doesn't expose it directly).
 */
export function compareShadowState(
  old: SystemState,
  next: SystemState,
): Discrepancy[] {
  const out: Discrepancy[] = [];

  if (old.gossipActivity !== next.gossipActivity) {
    out.push({
      field: "gossipActivity",
      old: old.gossipActivity,
      new: next.gossipActivity,
    });
  }

  if (old.status !== next.status) {
    out.push({
      field: "status",
      old: old.status,
      new: next.status,
    });
  }

  if (old.saveState !== next.saveState) {
    out.push({
      field: "saveState",
      old: old.saveState,
      new: next.saveState,
    });
  }

  if (old.ackedBy.size !== next.ackedBy.size) {
    out.push({
      field: "ackedBy.size",
      old: old.ackedBy.size,
      new: next.ackedBy.size,
    });
  }

  if (old.guaranteeUntil !== next.guaranteeUntil) {
    out.push({
      field: "guaranteeUntil",
      old: old.guaranteeUntil,
      new: next.guaranteeUntil,
    });
  }

  if (old.retainUntil !== next.retainUntil) {
    out.push({
      field: "retainUntil",
      old: old.retainUntil,
      new: next.retainUntil,
    });
  }

  return out;
}

function formatValue(v: unknown): string {
  if (v instanceof Set) return `Set(${v.size})`;
  return String(v);
}
