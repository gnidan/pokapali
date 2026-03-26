/**
 * facts.ts — Fact union, state interfaces, and
 * derived view functions for the state management
 * redesign.
 *
 * Pure types and projections. No logic beyond
 * type definitions and read-only views.
 */

import type { CID } from "multiformats/cid";
import type { KnownNode } from "./node-registry.js";

// ------------------------------------------------
// Fact types
// ------------------------------------------------

export type CidSource =
  | "gossipsub"
  | "ipns"
  | "http-tip"
  | "reannounce"
  | "chain-walk"
  | "pinner-index"
  | "cache";

export type Fact =
  // --- Chain discovery ---
  | {
      type: "cid-discovered";
      ts: number;
      cid: CID;
      source: CidSource;
      block?: Uint8Array;
      seq?: number;
      snapshotTs?: number;
    }
  | { type: "block-fetch-started"; ts: number; cid: CID }
  | {
      type: "block-fetched";
      ts: number;
      cid: CID;
      block: Uint8Array;
      prev?: CID;
      seq?: number;
      snapshotTs?: number;
    }
  | {
      type: "block-fetch-failed";
      ts: number;
      cid: CID;
      attempt: number;
      error: string;
    }
  // --- Tip lifecycle ---
  | {
      type: "tip-advanced";
      ts: number;
      cid: CID;
      seq: number;
    }
  | {
      type: "announced";
      ts: number;
      cid: CID;
      seq: number;
    }
  // --- Per-CID metadata ---
  | {
      type: "ack-received";
      ts: number;
      cid: CID;
      peerId: string;
    }
  | {
      type: "guarantee-received";
      ts: number;
      peerId: string;
      cid: CID;
      guaranteeUntil: number;
      retainUntil: number;
    }
  // --- Gossip ---
  | { type: "gossip-message"; ts: number }
  | { type: "gossip-subscribed"; ts: number }
  // --- Infrastructure ---
  | {
      type: "node-change";
      ts: number;
      peerId: string;
      node: KnownNode;
    }
  // --- Connectivity ---
  | {
      type: "sync-status-changed";
      ts: number;
      status: SyncStatus;
    }
  | {
      type: "awareness-status-changed";
      ts: number;
      connected: boolean;
    }
  | {
      type: "relay-connected";
      ts: number;
      peerId: string;
    }
  | {
      type: "relay-disconnected";
      ts: number;
      peerId: string;
    }
  // --- Persistence --- // Phase 7: adapt or remove
  | {
      type: "content-dirty";
      ts: number;
      clockSum: number;
    }
  | { type: "publish-started"; ts: number }
  | {
      type: "publish-succeeded";
      ts: number;
      cid: CID;
      seq: number;
    }
  | {
      type: "publish-failed";
      ts: number;
      error: string;
    }
  // --- Epoch lifecycle ---
  | {
      type: "epoch-closed";
      ts: number;
      channel: string;
      epochIndex: number;
    }
  | {
      type: "convergence-detected";
      ts: number;
      channel: string;
      hash: Uint8Array;
    }
  | {
      type: "snapshot-materialized";
      ts: number;
      channel: string;
      epochIndex: number;
      cid: CID;
    }
  // --- Edit lifecycle ---
  | {
      type: "edit-received";
      ts: number;
      channel: string;
      editHash: Uint8Array;
      origin: "local" | "remote";
    }
  | {
      type: "edit-verified";
      ts: number;
      channel: string;
      editHash: Uint8Array;
      author: Uint8Array;
    }
  // --- View cache ---
  | {
      type: "view-cache-loaded";
      ts: number;
      viewName: string;
      entries: number;
    }
  | {
      type: "view-cache-written";
      ts: number;
      viewName: string;
      entries: number;
    }
  // --- Discovery ---
  | {
      type: "pinner-discovered";
      ts: number;
      peerId: string;
    }
  // --- Guarantee queries ---
  | {
      type: "guarantee-query-sent";
      ts: number;
      peerId: string;
    }
  | {
      type: "guarantee-query-responded";
      ts: number;
      peerId: string;
    }
  // --- IPNS resolution ---
  | { type: "ipns-resolve-started"; ts: number }
  | {
      type: "ipns-resolve-completed";
      ts: number;
      cid: CID | null;
    }
  // --- Retry ---
  | { type: "block-retry-reset"; ts: number; cid: CID }
  // --- Timers ---
  | { type: "reannounce-tick"; ts: number }
  | { type: "tick"; ts: number };

// ------------------------------------------------
// Re-exported domain types (originals stay in their
// source modules; we re-export for convenience)
// ------------------------------------------------

/**
 * Document connectivity status.
 *
 * - `"connecting"` — establishing P2P connections
 * - `"synced"` — connected and syncing with peers
 * - `"receiving"` — receiving data (read-only peer)
 * - `"offline"` — no peer connections
 */
export type DocStatus = "connecting" | "synced" | "receiving" | "offline";

/**
 * Persistence state of a document.
 *
 * - `"saved"` — all changes persisted
 * - `"unpublished"` — new doc, never published
 * - `"saving"` — write in progress
 * - `"dirty"` — local changes not yet persisted
 * - `"save-error"` — last save attempt failed
 */
export type SaveState =
  | "saved"
  | "unpublished"
  | "saving"
  | "dirty"
  | "save-error";

/** Permission level derived from capability keys. */
export type DocRole = "admin" | "writer" | "reader";

export type SyncStatus = "connecting" | "connected" | "disconnected";

/**
 * GossipSub subscription state for the document's
 * announce topic.
 *
 * - `"inactive"` — not yet subscribed
 * - `"subscribed"` — subscribed, no messages yet
 * - `"receiving"` — actively receiving messages
 */
export type GossipActivity = "inactive" | "subscribed" | "receiving";

/**
 * Discriminated union representing the document's
 * initial load progress. Transitions: idle →
 * resolving → fetching → (retrying →)* applied
 * or failed.
 */
export type LoadingState =
  | { status: "idle" }
  | { status: "resolving"; startedAt: number }
  | {
      status: "fetching";
      cid: string;
      startedAt: number;
    }
  | {
      status: "retrying";
      cid: string;
      attempt: number;
      nextRetryAt: number;
    }
  | {
      status: "failed";
      cid: string;
      error: string;
    };

// ------------------------------------------------
// State interfaces
// ------------------------------------------------

export interface DocState {
  /** Immutable after creation. */
  identity: {
    ipnsName: string;
    role: DocRole;
    channels: string[];
    appId: string;
  };

  chain: ChainState;
  connectivity: Connectivity;
  content: ContentState;
  announce: AnnounceState;
  epochs: EpochState;

  pendingQueries: ReadonlyMap<string, { sentAt: number }>;
  ipnsStatus: IpnsResolutionStatus;

  /** Derived from connectivity. */
  status: DocStatus;
  /** Derived from content + chain. */
  saveState: SaveState;
}

export interface ChannelEpochState {
  openEpochCount: number;
  lastConvergenceHash: Uint8Array | null;
  dirty: boolean;
}

export interface EpochState {
  channels: Readonly<Record<string, ChannelEpochState>>;
  viewCacheStale: ReadonlySet<string>;
  pendingSnapshots: ReadonlySet<string>;
}

export interface ChainState {
  entries: ReadonlyMap<string, ChainEntry>;
  tip: CID | null;
  applying: CID | null;
  /**
   * Highest-seq "fetched" CID. Maintained by the
   * reducer to avoid scanning all entries in the
   * interpreter.
   */
  newestFetched: CID | null;
  /** Highest seq seen across all entries. Avoids
   *  O(n) scans for latestAnnouncedSeq. */
  maxSeq: number;
}

export interface ChainEntry {
  cid: CID;
  seq?: number;
  ts?: number;
  discoveredVia: ReadonlySet<CidSource>;
  blockStatus: "unknown" | "fetching" | "fetched" | "applied" | "failed";
  fetchAttempt: number;
  fetchStartedAt?: number;
  lastError?: string;
  prev?: CID;
  guarantees: ReadonlyMap<
    string,
    { guaranteeUntil: number; retainUntil: number }
  >;
  ackedBy: ReadonlySet<string>;
}

export interface Connectivity {
  syncStatus: SyncStatus;
  awarenessConnected: boolean;
  gossip: GossipState;
  relayPeers: ReadonlySet<string>;
  knownPinnerPids: ReadonlySet<string>;
  /** Timestamp (ms) when the doc was created.
   *  Used by deriveStatus() for mesh grace. */
  createdAt?: number;
}

export interface GossipState {
  activity: GossipActivity;
  subscribed: boolean;
  lastMessageAt: number;
}

export interface ContentState {
  clockSum: number;
  isDirty: boolean;
  isSaving: boolean;
  ipnsSeq: number | null;
  /** Error message from the last failed publish,
   *  or null if the last publish succeeded. */
  lastSaveError: string | null;
}

export interface AnnounceState {
  lastAnnouncedCid: CID | null;
  lastAnnounceAt: number;
  lastGuaranteeQueryAt: number;
}

export type IpnsResolutionStatus =
  | { phase: "idle" }
  | { phase: "resolving"; startedAt: number }
  | { phase: "resolved"; cid: CID; at: number };

// ------------------------------------------------
// Initial state
// ------------------------------------------------

export const INITIAL_GOSSIP: GossipState = {
  activity: "inactive",
  subscribed: false,
  lastMessageAt: 0,
};

export const INITIAL_CONNECTIVITY: Connectivity = {
  syncStatus: "disconnected",
  awarenessConnected: false,
  gossip: INITIAL_GOSSIP,
  relayPeers: new Set(),
  knownPinnerPids: new Set(),
};

export const INITIAL_CONTENT: ContentState = {
  clockSum: 0,
  isDirty: false,
  isSaving: false,
  ipnsSeq: null,
  lastSaveError: null,
};

/** Shared empty set — avoids repeat allocations. */
export const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Shared empty guarantees map. */
export const EMPTY_GUARANTEES: ReadonlyMap<
  string,
  { guaranteeUntil: number; retainUntil: number }
> = new Map();

export const INITIAL_CHAIN: ChainState = {
  entries: new Map(),
  tip: null,
  applying: null,
  newestFetched: null,
  maxSeq: 0,
};

export const INITIAL_EPOCHS: EpochState = {
  channels: {},
  viewCacheStale: new Set(),
  pendingSnapshots: new Set(),
};

export function initialDocState(identity: {
  ipnsName: string;
  role: DocRole;
  channels: string[];
  appId: string;
}): DocState {
  return {
    identity,
    chain: INITIAL_CHAIN,
    connectivity: INITIAL_CONNECTIVITY,
    content: INITIAL_CONTENT,
    announce: {
      lastAnnouncedCid: null,
      lastAnnounceAt: 0,
      lastGuaranteeQueryAt: 0,
    },
    epochs: INITIAL_EPOCHS,
    pendingQueries: new Map(),
    ipnsStatus: { phase: "idle" },
    status: "offline",
    saveState: "unpublished",
  };
}

// ------------------------------------------------
// Derived views (pure projections)
// ------------------------------------------------

export interface VersionSummary {
  cid: CID;
  seq: number;
  ts: number;
  available: boolean;
}

export function versionHistory(chain: ChainState): VersionSummary[] {
  return [...chain.entries.values()]
    .filter((e): e is ChainEntry & { seq: number } => e.seq != null)
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({
      cid: e.cid,
      seq: e.seq,
      ts: e.ts ?? 0,
      available: e.blockStatus === "fetched" || e.blockStatus === "applied",
    }));
}

// ------------------------------------------------
// Reactive version history (Feed-oriented)
// ------------------------------------------------

/** Fetch status of a single version entry. */
export type VersionEntryStatus = "available" | "loading" | "failed";

/** A single entry in the reactive version history
 *  feed. */
export interface VersionHistoryEntry {
  /** Content identifier for this snapshot. */
  cid: CID;
  /** Sequence number in the chain. */
  seq: number;
  /** Unix timestamp (ms) when created. */
  ts: number;
  /** Whether the block has been fetched. */
  status: VersionEntryStatus;
}

export interface VersionHistory {
  /** Known versions, sorted by seq desc.
   *  Includes loading/failed entries. */
  readonly entries: ReadonlyArray<VersionHistoryEntry>;
  /** True while chain-walk is in progress
   *  (entries with unknown/fetching blocks). */
  readonly walking: boolean;
}

function entryStatus(bs: ChainEntry["blockStatus"]): VersionEntryStatus {
  if (bs === "fetched" || bs === "applied") {
    return "available";
  }
  if (bs === "failed") return "failed";
  return "loading";
}

/** Derive a reactive VersionHistory from one or two
 *  chain states (interpreter + optional localChain).
 */
export function deriveVersionHistory(
  chain: ChainState | null,
  localChain?: ChainState | null,
): VersionHistory {
  const seen = new Map<string, VersionHistoryEntry>();
  let walking = false;

  // Interpreter chain — authoritative.
  if (chain) {
    for (const e of chain.entries.values()) {
      if (e.seq == null) continue;
      const s = entryStatus(e.blockStatus);
      if (s === "loading") walking = true;
      seen.set(e.cid.toString(), {
        cid: e.cid,
        seq: e.seq,
        ts: e.ts ?? 0,
        status: s,
      });
    }
  }

  // Local chain — fills in recent publishes the
  // interpreter hasn't processed yet.
  if (localChain) {
    for (const e of localChain.entries.values()) {
      if (e.seq == null) continue;
      const key = e.cid.toString();
      if (seen.has(key)) continue;
      const s = entryStatus(e.blockStatus);
      if (s === "loading") walking = true;
      seen.set(key, {
        cid: e.cid,
        seq: e.seq,
        ts: e.ts ?? 0,
        status: s,
      });
    }
  }

  const entries = [...seen.values()].sort((a, b) => b.seq - a.seq);

  return { entries, walking };
}

export interface BestGuarantee {
  guaranteeUntil: number;
  retainUntil: number;
}

export function bestGuarantee(chain: ChainState): BestGuarantee {
  let g = 0;
  let r = 0;
  for (const entry of chain.entries.values()) {
    for (const guar of entry.guarantees.values()) {
      g = Math.max(g, guar.guaranteeUntil);
      r = Math.max(r, guar.retainUntil);
    }
  }
  return { guaranteeUntil: g, retainUntil: r };
}

/** Tolerance for clock skew between peers (5 min). */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Check whether a guarantee timestamp is still active,
 * accounting for clock skew between peers.
 *
 * A pinner whose clock is ahead will issue guarantees
 * that appear to expire early from the browser's
 * perspective. The tolerance window prevents false
 * "expired" status from minor clock drift.
 */
export function isGuaranteeActive(
  guaranteeUntil: number,
  now?: number,
): boolean {
  if (guaranteeUntil === 0) return false;
  const t = now ?? Date.now();
  return guaranteeUntil + CLOCK_SKEW_TOLERANCE_MS > t;
}
