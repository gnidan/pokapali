/**
 * reducers.ts — Pure reducers for the fact-stream
 * state management architecture.
 *
 * Every function is pure: (state, fact) → state.
 * No side effects, no imports beyond types.
 * Structural sharing for Sets/Maps.
 */

import type {
  Fact,
  DocState,
  ChainState,
  ChainEntry,
  Connectivity,
  GossipState,
  ContentState,
  AnnounceState,
  DocStatus,
  SaveState,
  CidSource,
  IpnsResolutionStatus,
} from "./facts.js";
import { EMPTY_SET, EMPTY_GUARANTEES } from "./facts.js";

// ------------------------------------------------
// Constants
// ------------------------------------------------

const GOSSIP_DECAY_MS = 60_000;

// ------------------------------------------------
// Immutable helpers
// ------------------------------------------------

function mapSet<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  value: V,
): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function mapDelete<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

// ------------------------------------------------
// Chain reducer
// ------------------------------------------------

function updateEntry(
  state: ChainState,
  cid: { toString(): string },
  fn: (e: ChainEntry) => ChainEntry,
): ChainState {
  const key = cid.toString();
  const existing = state.entries.get(key);
  if (!existing) return state;
  return {
    ...state,
    entries: mapSet(state.entries, key, fn(existing)),
  };
}

/**
 * Recompute newestFetched pointer. Only called when
 * blockStatus changes. O(n) but only runs on status
 * transitions, not every fact.
 */
function withNewestFetched(state: ChainState): ChainState {
  let best: { cid: import("multiformats/cid").CID; seq: number } | null = null;
  for (const e of state.entries.values()) {
    if (e.blockStatus !== "fetched") continue;
    const seq = e.seq ?? 0;
    if (!best || seq > best.seq) {
      best = { cid: e.cid, seq };
    }
  }
  const bestCid = best?.cid ?? null;
  if (bestCid === state.newestFetched) return state;
  return { ...state, newestFetched: bestCid };
}

export function reduceChain(state: ChainState, fact: Fact): ChainState {
  if (fact.type === "cid-discovered") {
    const key = fact.cid.toString();
    const existing = state.entries.get(key);

    if (existing) {
      // Failed → unknown (retry path)
      if (existing.blockStatus === "failed") {
        return withNewestFetched({
          ...state,
          entries: mapSet(state.entries, key, {
            ...existing,
            blockStatus: "unknown",
            fetchAttempt: 0,
            lastError: undefined,
            discoveredVia: new Set([...existing.discoveredVia, fact.source]),
          }),
        });
      }
      // Already known — merge discovery info
      const newBlockStatus = fact.block ? "fetched" : existing.blockStatus;
      const changed =
        newBlockStatus !== existing.blockStatus ||
        !existing.discoveredVia.has(fact.source) ||
        (fact.seq != null && existing.seq == null) ||
        (fact.snapshotTs != null && existing.ts == null);
      if (!changed) return state;
      const mergedSeq = existing.seq ?? fact.seq;
      const mergeMaxSeq =
        mergedSeq != null ? Math.max(state.maxSeq, mergedSeq) : state.maxSeq;
      return withNewestFetched({
        ...state,
        maxSeq: mergeMaxSeq,
        entries: mapSet(state.entries, key, {
          ...existing,
          discoveredVia: existing.discoveredVia.has(fact.source)
            ? existing.discoveredVia
            : new Set([...existing.discoveredVia, fact.source]),
          seq: existing.seq ?? fact.seq,
          ts: existing.ts ?? fact.snapshotTs,
          blockStatus: newBlockStatus as ChainEntry["blockStatus"],
        }),
      });
    }

    // New CID
    const newMaxSeq =
      fact.seq != null ? Math.max(state.maxSeq, fact.seq) : state.maxSeq;
    return withNewestFetched({
      ...state,
      maxSeq: newMaxSeq,
      entries: mapSet(state.entries, key, {
        cid: fact.cid,
        seq: fact.seq,
        ts: fact.snapshotTs,
        discoveredVia: new Set([fact.source]),
        blockStatus: fact.block ? "fetched" : "unknown",
        fetchAttempt: 0,
        guarantees: EMPTY_GUARANTEES,
        ackedBy: EMPTY_SET,
      }),
    });
  }

  if (fact.type === "block-fetch-started") {
    return updateEntry(state, fact.cid, (e) => ({
      ...e,
      blockStatus: "fetching",
      fetchStartedAt: fact.ts,
    }));
  }

  if (fact.type === "block-fetched") {
    const existing = state.entries.get(fact.cid.toString());
    const resolvedSeq = existing?.seq ?? fact.seq;
    const fetchMaxSeq =
      resolvedSeq != null ? Math.max(state.maxSeq, resolvedSeq) : state.maxSeq;
    let next = updateEntry(
      { ...state, maxSeq: fetchMaxSeq },
      fact.cid,
      (e) => ({
        ...e,
        blockStatus: "fetched" as const,
        prev: fact.prev,
        seq: e.seq ?? fact.seq,
        ts: e.ts ?? fact.snapshotTs,
      }),
    );
    // Chain walk: discover prev CID
    if (fact.prev) {
      const prevKey = fact.prev.toString();
      if (!next.entries.has(prevKey)) {
        next = {
          ...next,
          entries: mapSet(next.entries, prevKey, {
            cid: fact.prev,
            discoveredVia: new Set<CidSource>(["chain-walk"]),
            blockStatus: "unknown",
            fetchAttempt: 0,
            guarantees: EMPTY_GUARANTEES,
            ackedBy: EMPTY_SET,
          }),
        };
      }
    }
    return withNewestFetched(next);
  }

  if (fact.type === "block-fetch-failed") {
    return withNewestFetched(
      updateEntry(state, fact.cid, (e) => ({
        ...e,
        blockStatus: "failed",
        fetchAttempt: fact.attempt,
        lastError: fact.error,
      })),
    );
  }

  if (fact.type === "tip-advanced") {
    const tipEntry = state.entries.get(fact.cid.toString());
    const tipSeq = tipEntry?.seq ?? fact.seq;
    const tipMaxSeq = Math.max(state.maxSeq, tipSeq);
    return withNewestFetched({
      ...updateEntry(state, fact.cid, (e) => ({
        ...e,
        blockStatus: "applied" as const,
        seq: e.seq ?? fact.seq,
      })),
      tip: fact.cid,
      applying: null,
      maxSeq: tipMaxSeq,
    });
  }

  if (fact.type === "ack-received") {
    const key = fact.cid.toString();
    const existing = state.entries.get(key);
    if (!existing) return state;
    if (existing.ackedBy.has(fact.peerId)) return state;
    return updateEntry(state, fact.cid, (e) => ({
      ...e,
      ackedBy: new Set([...e.ackedBy, fact.peerId]),
    }));
  }

  if (fact.type === "guarantee-received") {
    return updateEntry(state, fact.cid, (e) => ({
      ...e,
      guarantees: mapSet(e.guarantees, fact.peerId, {
        guaranteeUntil: fact.guaranteeUntil,
        retainUntil: fact.retainUntil,
      }),
    }));
  }

  return state;
}

// ------------------------------------------------
// Connectivity reducer
// ------------------------------------------------

export function reduceGossip(state: GossipState, fact: Fact): GossipState {
  if (fact.type === "gossip-subscribed") {
    return {
      ...state,
      subscribed: true,
      activity: state.activity === "inactive" ? "subscribed" : state.activity,
    };
  }

  if (fact.type === "gossip-message") {
    return {
      ...state,
      lastMessageAt: fact.ts,
      activity: "receiving",
    };
  }

  // Any fact can trigger decay check via wall-clock
  if (
    state.activity === "receiving" &&
    fact.ts - state.lastMessageAt > GOSSIP_DECAY_MS
  ) {
    return {
      ...state,
      activity: state.subscribed ? "subscribed" : "inactive",
    };
  }

  return state;
}

export function reduceConnectivity(
  state: Connectivity,
  fact: Fact,
): Connectivity {
  if (fact.type === "sync-status-changed") {
    return { ...state, syncStatus: fact.status };
  }

  if (fact.type === "awareness-status-changed") {
    return {
      ...state,
      awarenessConnected: fact.connected,
    };
  }

  if (
    fact.type === "gossip-message" ||
    fact.type === "gossip-subscribed" ||
    fact.type === "tick"
  ) {
    const gossip = reduceGossip(state.gossip, fact);
    if (gossip === state.gossip) return state;
    return { ...state, gossip };
  }

  if (fact.type === "relay-connected") {
    if (state.relayPeers.has(fact.peerId)) return state;
    return {
      ...state,
      relayPeers: new Set([...state.relayPeers, fact.peerId]),
    };
  }

  if (fact.type === "relay-disconnected") {
    if (!state.relayPeers.has(fact.peerId)) return state;
    const next = new Set(state.relayPeers);
    next.delete(fact.peerId);
    return { ...state, relayPeers: next };
  }

  if (fact.type === "pinner-discovered") {
    if (state.knownPinnerPids.has(fact.peerId)) {
      return state;
    }
    return {
      ...state,
      knownPinnerPids: new Set([...state.knownPinnerPids, fact.peerId]),
    };
  }

  return state;
}

// ------------------------------------------------
// Content reducer
// ------------------------------------------------

export function reduceContent(state: ContentState, fact: Fact): ContentState {
  if (fact.type === "content-dirty") {
    return {
      ...state,
      clockSum: fact.clockSum,
      isDirty: true,
    };
  }

  if (fact.type === "publish-started") {
    return { ...state, isSaving: true };
  }

  if (fact.type === "publish-succeeded") {
    return {
      ...state,
      isSaving: false,
      isDirty: false,
      ipnsSeq: fact.seq,
    };
  }

  if (fact.type === "publish-failed") {
    return { ...state, isSaving: false };
  }

  return state;
}

// ------------------------------------------------
// Announce reducer
// ------------------------------------------------

export function reduceAnnounce(
  state: AnnounceState,
  fact: Fact,
): AnnounceState {
  if (fact.type === "announced") {
    return {
      ...state,
      lastAnnouncedCid: fact.cid,
      lastAnnounceAt: fact.ts,
    };
  }

  if (fact.type === "relay-connected") {
    // Sentinel: force immediate reannounce
    return { ...state, lastAnnounceAt: 0 };
  }

  if (fact.type === "guarantee-query-sent") {
    return {
      ...state,
      lastGuaranteeQueryAt: fact.ts,
    };
  }

  return state;
}

// ------------------------------------------------
// Pending queries reducer
// ------------------------------------------------

function reducePendingQueries(
  state: ReadonlyMap<string, { sentAt: number }>,
  fact: Fact,
): ReadonlyMap<string, { sentAt: number }> {
  if (fact.type === "guarantee-query-sent") {
    return mapSet(state, fact.peerId, {
      sentAt: fact.ts,
    });
  }
  if (fact.type === "guarantee-query-responded") {
    if (!state.has(fact.peerId)) return state;
    return mapDelete(state, fact.peerId);
  }
  return state;
}

// ------------------------------------------------
// IPNS status reducer
// ------------------------------------------------

function reduceIpnsStatus(
  state: IpnsResolutionStatus,
  fact: Fact,
): IpnsResolutionStatus {
  if (fact.type === "ipns-resolve-started") {
    return { phase: "resolving", startedAt: fact.ts };
  }
  if (fact.type === "ipns-resolve-completed") {
    if (fact.cid) {
      return {
        phase: "resolved",
        cid: fact.cid,
        at: fact.ts,
      };
    }
    return { phase: "idle" };
  }
  return state;
}

// ------------------------------------------------
// Derived status
// ------------------------------------------------

/**
 * Ported from create-doc computeStatus() — exact
 * same 6-branch logic.
 */
export function deriveStatus(c: Connectivity): DocStatus {
  if (c.syncStatus === "connected") return "synced";
  if (c.syncStatus === "connecting") return "connecting";
  if (c.awarenessConnected) return "receiving";
  if (c.gossip.activity === "receiving") {
    return "receiving";
  }
  if (c.gossip.activity === "subscribed") {
    return "connecting";
  }
  return "offline";
}

/**
 * Save state derivation. Takes content + chain
 * because "saved" vs "unpublished" depends on
 * whether a tip exists.
 */
export function deriveSaveState(
  content: ContentState,
  chain: ChainState,
): SaveState {
  if (content.isSaving) return "saving";
  if (content.isDirty) return "dirty";
  if (chain.tip) return "saved";
  return "unpublished";
}

// ------------------------------------------------
// Top-level combiner
// ------------------------------------------------

export function reduce(state: DocState, fact: Fact): DocState {
  const chain = reduceChain(state.chain, fact);
  const connectivity = reduceConnectivity(state.connectivity, fact);
  const content = reduceContent(state.content, fact);
  const announce = reduceAnnounce(state.announce, fact);
  const pendingQueries = reducePendingQueries(state.pendingQueries, fact);
  const ipnsStatus = reduceIpnsStatus(state.ipnsStatus, fact);

  // Structural sharing: if nothing changed, return
  // the same object
  if (
    chain === state.chain &&
    connectivity === state.connectivity &&
    content === state.content &&
    announce === state.announce &&
    pendingQueries === state.pendingQueries &&
    ipnsStatus === state.ipnsStatus
  ) {
    return state;
  }

  const status = deriveStatus(connectivity);
  const saveState = deriveSaveState(content, chain);

  // Only create new object if derived values also
  // changed
  if (
    chain === state.chain &&
    connectivity === state.connectivity &&
    content === state.content &&
    announce === state.announce &&
    pendingQueries === state.pendingQueries &&
    ipnsStatus === state.ipnsStatus &&
    status === state.status &&
    saveState === state.saveState
  ) {
    return state;
  }

  return {
    ...state,
    chain,
    connectivity,
    content,
    announce,
    pendingQueries,
    ipnsStatus,
    status,
    saveState,
  };
}
