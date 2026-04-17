/**
 * ingest-snapshot.ts — unified ingress for snapshot
 * blocks (local authored + peer received).
 *
 * Spec: design-snapshot-exchange-integration.md
 * §"A3 implementation spec — ingestSnapshot +
 *  sideband-pending-rescan" (architect memory,
 *  added 2026-04-16).
 *
 * This module owns:
 *   - the `ingestSnapshot(cid, data, opts)` function
 *   - the `isPlaceable(block, state)` structural check
 *   - the pending-sideband quarantine + FIFO eviction
 *   - the rescan helper fired by reconcile-cycle-end
 *
 * Sideband rationale: when a peer delivers a snapshot
 * whose parent epoch is not yet in our chain.entries
 * ("unknown-epoch"), we can't link it. Rather than
 * reject-and-refetch, we hold the bytes sideband and
 * re-attempt placement on each reconcile-cycle
 * completion (peer-edit arrivals are the only event
 * class that fills intermediate epochs). Cap 10 entries
 * OR 10MB, FIFO eviction → "pending-overflow".
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { decodeSnapshot, validateSnapshot } from "@pokapali/blocks";
import type { Document } from "@pokapali/document";
import { createLogger } from "@pokapali/log";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import type { DocState } from "./facts.js";

const log = createLogger("ingest-snapshot");

/**
 * Signals that a snapshot was received + valid, but its
 * parent epoch is not yet in `chain.entries`, so it has
 * been quarantined in the sideband. Callers (notably the
 * interpreter) should catch this and skip tip advance
 * without surfacing a validation error — it's a deferred
 * placement, not a failure. A later `rescanPending()`
 * call will re-attempt placement.
 */
export class PendingIngestError extends Error {
  override name = "PendingIngestError" as const;
  constructor(public readonly cid: string) {
    super("Snapshot deferred (parent epoch unknown): " + cid);
  }
}

// -----------------------------------------------------
// Types
// -----------------------------------------------------

export interface IngestSnapshotOptions {
  source: "local" | "peer";
  /** Peer that served the block, when source === "peer".
   *  Plumbed for pinner enrichment + D3 diagnostics;
   *  not required for correctness. */
  peerId?: string;
}

export type IngestRejectReason =
  /** validateSnapshot (doc + publisher sigs) failed. */
  | "invalid-signature"
  /** sha256(data) did not match cid.multihash.digest. */
  | "cid-mismatch"
  /** Already present in SnapshotHistory — no-op. */
  | "duplicate"
  /** Parent epoch missing → held in sideband. */
  | "unplaceable-epoch"
  /** Sideband FIFO-evicted this entry. Terminal. */
  | "pending-overflow";

export interface IngestResult {
  /** "placed" — integrated, tree updated, history emitted.
   *  "pending" — held in sideband, awaiting bridging
   *              epochs.
   *  "rejected" — failed validation/placement and
   *               won't be retried. */
  outcome: "placed" | "pending" | "rejected";
  /** Reason code when outcome !== "placed". */
  reason?: IngestRejectReason;
}

export interface IngestOutcomeRecord {
  cid: CID;
  outcome: "placed" | "pending" | "rejected";
  reason?: IngestRejectReason;
  source: "local" | "peer";
  peerId?: string;
  ts: number;
  /** True iff this outcome came from a rescan attempt
   *  (vs first ingest attempt). Lets D3 measure
   *  bridging success rate without re-tagging. */
  fromRescan: boolean;
}

// -----------------------------------------------------
// Structural placement predicate
// -----------------------------------------------------

/**
 * Can this snapshot link into our epoch tree?
 *
 * Genesis-adjacent (prev == null) always places.
 * Otherwise the parent CID must be present in
 * `state.chain.entries`.
 *
 * This is the STRUCTURAL check. Cryptographic
 * anchoring (signature anchors correctly to the
 * claimed parent's state-vector) is handled by
 * `validateSnapshot`; this predicate only asks
 * "do we have the parent?"
 *
 * Returns false if the block is undecodable.
 */
export function isPlaceable(
  block: Uint8Array,
  state: Pick<DocState, "chain">,
): boolean {
  let decoded;
  try {
    decoded = decodeSnapshot(block);
  } catch {
    return false;
  }
  if (decoded.prev == null) return true;
  return state.chain.entries.has(decoded.prev.toString());
}

// -----------------------------------------------------
// Pending sideband — bounded FIFO quarantine
// -----------------------------------------------------

const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface PendingSidebandOptions {
  /** Max entries before FIFO eviction. Default 10. */
  maxEntries?: number;
  /** Max total bytes before FIFO eviction.
   *  Default 10 MiB. */
  maxBytes?: number;
  /** Fired when an entry is FIFO-evicted (overflow).
   *  Callers use this to emit a terminal
   *  "pending-overflow" outcome for D3. */
  onEvict?: (cid: string, data: Uint8Array) => void;
}

export interface PendingSideband {
  /** Number of entries currently pending. */
  readonly size: number;
  /** Total bytes across all pending entries. */
  readonly totalBytes: number;
  /** Add a pending entry. No-op on duplicate CID.
   *  May FIFO-evict oldest entries to satisfy cap;
   *  evictions fire `onEvict`. */
  add(cid: string, data: Uint8Array): void;
  /** Remove an entry (e.g., when it becomes placeable
   *  via rescan). No-op if absent. */
  remove(cid: string): void;
  /** True if CID is currently pending. */
  has(cid: string): boolean;
  /** Iterate pending entries in insertion order.
   *  Intended for rescan pass: callers should snapshot
   *  the iteration (e.g., `Array.from(entries())`)
   *  before mutating during rescan. */
  entries(): IterableIterator<[string, Uint8Array]>;
}

/**
 * Bounded sideband quarantine with FIFO eviction.
 *
 * Insertion order is preserved via Map iteration
 * semantics; FIFO evicts `pending.keys().next().value`.
 */
export function createPendingSideband(
  opts?: PendingSidebandOptions,
): PendingSideband {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const onEvict = opts?.onEvict;

  const pending = new Map<string, Uint8Array>();
  let totalBytes = 0;

  function evictOldest(): void {
    const firstKey = pending.keys().next().value;
    if (firstKey === undefined) return;
    const data = pending.get(firstKey);
    if (data === undefined) return;
    pending.delete(firstKey);
    totalBytes -= data.byteLength;
    onEvict?.(firstKey, data);
  }

  return {
    get size() {
      return pending.size;
    },
    get totalBytes() {
      return totalBytes;
    },
    add(cid, data) {
      // No-op on duplicate add — rescan re-processes
      // via the existing entry.
      if (pending.has(cid)) return;
      pending.set(cid, data);
      totalBytes += data.byteLength;
      // Evict oldest until both caps satisfied.
      // (Note: if the single new entry itself exceeds
      // maxBytes, it will evict itself on the next
      // iteration — that's the intended behavior; a
      // too-large block doesn't fit the sideband.)
      while (
        pending.size > maxEntries ||
        (pending.size > 0 && totalBytes > maxBytes)
      ) {
        evictOldest();
      }
    },
    remove(cid) {
      const data = pending.get(cid);
      if (data === undefined) return;
      pending.delete(cid);
      totalBytes -= data.byteLength;
    },
    has(cid) {
      return pending.has(cid);
    },
    entries() {
      return pending.entries();
    },
  };
}

// -----------------------------------------------------
// CID integrity
// -----------------------------------------------------

/**
 * Verify sha256(data) matches cid.multihash.digest.
 * First gate in the ingress pipeline — cheaper than
 * signature verification and catches gross tampering
 * or wrong-cid-wrong-bytes pairings before we spend
 * CPU on crypto.
 */
async function verifyCidIntegrity(
  cid: CID,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const hash = await sha256.digest(data);
    const expected = cid.multihash.digest;
    if (hash.digest.byteLength !== expected.byteLength) return false;
    for (let i = 0; i < expected.byteLength; i++) {
      if (hash.digest[i] !== expected[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------
// ingestSnapshot orchestrator
// -----------------------------------------------------

/**
 * Context for an ingest attempt — captures the source
 * metadata so rescan retries can preserve the original
 * provenance for `IngestOutcomeRecord.source/peerId`.
 */
interface PendingContext {
  source: "local" | "peer";
  peerId?: string;
}

export interface CreateIngestSnapshotDeps {
  snapshotCodec: SnapshotCodec;
  document?: Document;
  resolver: BlockResolver;
  readKey: CryptoKey;
  getClockSum: () => number;
  /**
   * Returns current doc state for structural placement +
   * dedupe checks. Called synchronously each ingest —
   * caller is responsible for returning up-to-date state
   * (in practice: the runtime's scanned stateStream
   * captures this via closure).
   */
  getState: () => Pick<DocState, "chain">;
  /**
   * Fired on every terminal ingest outcome (placed,
   * pending, rejected). Consumer: D3 diagnostics view.
   * Optional — zero-cost when unset.
   */
  onIngestOutcome?: (record: IngestOutcomeRecord) => void;
  /**
   * Sideband cap overrides — defaults to 10 entries /
   * 10 MiB per spec. Exposed for tests + future tuning.
   */
  sidebandOptions?: PendingSidebandOptions;
}

export interface IngestSnapshotApi {
  /**
   * Validate + place or quarantine a snapshot block.
   * Outcome semantics (architect spec §A3 tip advance
   * table):
   *
   *   placed + seq > tip: caller observes tip advance
   *     (via the normal chain reducer path).
   *   placed + seq ≤ tip: history-emit only — late-
   *     joiner backfill; reducer still records the
   *     entry but tip stays.
   *   pending: held in sideband; may transition to
   *     placed via rescanPending() on a later cycle.
   *   rejected: terminal; will not be retried.
   */
  ingestSnapshot(
    cid: CID,
    data: Uint8Array,
    opts: IngestSnapshotOptions,
  ): Promise<IngestResult>;
  /**
   * Re-attempt placement for all sidebanded entries.
   * Callers: wire to reconcile-cycle-end so bridging
   * peer-edit arrivals have a chance to link previously
   * unplaceable epochs.
   *
   * Each successful placement removes the entry from the
   * sideband. Failed retries remain (subject to FIFO
   * eviction). Each retry fires `onIngestOutcome` with
   * `fromRescan: true`.
   */
  rescanPending(): Promise<void>;
  /** Current sideband size (entries). Exposed for D3 /
   *  tests — avoid coupling internals. */
  readonly pendingSize: number;
}

/**
 * Create the unified ingress orchestrator.
 *
 * This is the single ingestion path for snapshot blocks
 * — both local authored (via publish → interpreter →
 * applySnapshot) and peer-received (via reconciliation
 * / gossip → applySnapshot, A4 will add a direct catalog
 * path). It encapsulates:
 *
 *   1. CID integrity (sha256 match)
 *   2. Signature validation
 *   3. Duplicate detection (chain.entries "applied")
 *   4. Structural placement (isPlaceable)
 *   5. Apply via snapshotCodec.applyRemote OR sideband
 *   6. Outcome emission for D3
 *
 * Caller still owns fact-stream updates + tip-advance
 * feedback — this keeps the interpreter's existing
 * state machine intact while centralising the
 * accept/defer/reject decision.
 */
export function createIngestSnapshot(
  deps: CreateIngestSnapshotDeps,
): IngestSnapshotApi {
  const {
    snapshotCodec,
    document,
    resolver,
    readKey,
    getClockSum,
    getState,
    onIngestOutcome,
    sidebandOptions,
  } = deps;

  // Track CIDs that have been successfully placed so the
  // duplicate gate (Gate 3) catches the catalog-vs-gossip
  // race: when onSnapshotReceived places a block before
  // the interpreter's applySnapshot call, the chain entry
  // is still "fetched" (not "applied"), but this set knows
  // the block was already processed. Prevents double-apply
  // of applyRemote to the Y.Doc.
  const placedCids = new Set<string>();

  // Parallel tracking for rescan: the sideband stores
  // just bytes (keeping eviction simple), while this
  // Map preserves the original PendingContext so each
  // retry re-emits the outcome with correct source/
  // peerId. Kept in sync with the sideband via the
  // onEvict hook + explicit deletes on remove/place.
  const pendingContexts = new Map<string, PendingContext>();

  const sideband = createPendingSideband({
    ...sidebandOptions,
    onEvict: (cidStr, data) => {
      // Forward user's onEvict first (if any) so test
      // hooks + future plumbing see the eviction before
      // we emit the terminal outcome record.
      sidebandOptions?.onEvict?.(cidStr, data);
      const ctx = pendingContexts.get(cidStr);
      pendingContexts.delete(cidStr);
      onIngestOutcome?.({
        cid: parseCidOrNull(cidStr) ?? (undefined as unknown as CID),
        outcome: "rejected",
        reason: "pending-overflow",
        source: ctx?.source ?? "peer",
        peerId: ctx?.peerId,
        ts: Date.now(),
        fromRescan: false,
      });
    },
  });

  function emit(record: IngestOutcomeRecord): void {
    onIngestOutcome?.(record);
  }

  /**
   * Core ingest step — shared between first-attempt and
   * rescan paths. Returns the terminal IngestResult;
   * the caller decides whether/how to emit the outcome
   * record (since rescan needs `fromRescan: true`).
   *
   * @param eagerApply  When true, decrypt + apply the
   *   block via snapshotCodec.applyRemote immediately
   *   (tip-case: the caller knows this CID is the tip
   *   candidate). When false, only validate + store
   *   bytes in the resolver — the interpreter will
   *   discover the block in its next cycle and apply
   *   it then. Rescan passes false because it bypasses
   *   the interpreter's tip-selection gate; first-ingest
   *   passes true because the interpreter already gated
   *   on tip candidacy before calling applySnapshot.
   */
  async function attempt(
    cid: CID,
    data: Uint8Array,
    _opts: IngestSnapshotOptions,
    eagerApply: boolean,
  ): Promise<IngestResult> {
    const cidStr = cid.toString();

    // Gate 1 — CID integrity.
    const cidOk = await verifyCidIntegrity(cid, data);
    if (!cidOk) {
      return { outcome: "rejected", reason: "cid-mismatch" };
    }

    // Gate 2 — signature validation.
    const sigOk = await validateSnapshot(data);
    if (!sigOk) {
      return { outcome: "rejected", reason: "invalid-signature" };
    }

    // Gate 3 — duplicate. Two checks:
    //   (a) chain says "applied" — reducer processed a
    //       tip-advanced fact for this CID.
    //   (b) placedCids has it — the catalog exchange path
    //       placed + applied this CID before the interpreter
    //       could push tip-advanced (race window).
    // Both are benign no-ops; return "duplicate".
    if (placedCids.has(cidStr)) {
      return { outcome: "rejected", reason: "duplicate" };
    }
    const entry = getState().chain.entries.get(cidStr);
    if (entry?.blockStatus === "applied") {
      return { outcome: "rejected", reason: "duplicate" };
    }

    // Gate 4 — structural placement. Bytes are valid, so
    // we still want them in BlockResolver regardless —
    // other peers may later request this CID via catalog
    // exchange, and if the epoch gap bridges later we
    // avoid a re-fetch (spec §"Sideband-pending interaction
    // with BlockResolver").
    if (!isPlaceable(data, getState())) {
      resolver.put(cid, data);
      return { outcome: "pending", reason: "unplaceable-epoch" };
    }

    // Gate 5 — place. Always store bytes so resolver.get()
    // succeeds for later tip-advance or catalog exchange.
    resolver.put(cid, data);

    // Eager apply: decrypt + apply state to the Y.Doc.
    // Only for tip candidates (first-ingest via the
    // interpreter's applySnapshot call). Rescan-placed
    // blocks skip this — the interpreter rediscovers
    // the CID as "fetched" in its next cycle and applies
    // it then, preserving the pre-A3 invariant that
    // applyRemote only fires for tip-advance.
    if (eagerApply) {
      try {
        await snapshotCodec.applyRemote(cid, readKey, (plaintext) => {
          if (document) {
            for (const [ch, state] of Object.entries(plaintext)) {
              document.channel(ch).appendSnapshot(state);
              if (document.hasSurface(ch)) {
                document.surface(ch).applyState(state);
              }
            }
          }
        });
        // Clock bump mirrors snapshot-ops.ts: regardless
        // of applyRemote's idempotent-return (which only
        // reports "already applied" within this codec
        // instance's memory), we bump the IPNS clock to
        // reflect that this node observed the snapshot.
        snapshotCodec.setLastIpnsSeq(getClockSum());
      } catch (err) {
        log.warn("applyRemote failed during ingest:", err);
        // Treat codec-level apply failures as invalid:
        // the signatures passed + the structure linked,
        // but decrypt/apply blew up, so the block is
        // effectively useless to us. This is rare and
        // non-retryable (bad readKey, corrupt state).
        return { outcome: "rejected", reason: "invalid-signature" };
      }
    }

    placedCids.add(cidStr);
    return { outcome: "placed" };
  }

  async function ingestSnapshot(
    cid: CID,
    data: Uint8Array,
    opts: IngestSnapshotOptions,
  ): Promise<IngestResult> {
    const cidStr = cid.toString();
    // Eager apply: the interpreter already gated on tip
    // candidacy before calling applySnapshot, so the
    // first-ingest path always eagerly decrypts + applies.
    const result = await attempt(cid, data, opts, true);

    // Sideband book-keeping on the three outcomes.
    if (result.outcome === "placed") {
      // If this CID was previously sidebanded (first-
      // attempt was unplaceable but now places via a
      // bridging fact), clean up the quarantine.
      if (sideband.has(cidStr)) {
        sideband.remove(cidStr);
        pendingContexts.delete(cidStr);
      }
    } else if (result.outcome === "pending") {
      // Stash bytes + context. No-op on duplicate add
      // (sideband semantics) — preserves the original
      // arrival time for FIFO fairness.
      pendingContexts.set(cidStr, {
        source: opts.source,
        peerId: opts.peerId,
      });
      sideband.add(cidStr, data);
    }
    // Rejected: nothing to quarantine.

    emit({
      cid,
      outcome: result.outcome,
      reason: result.reason,
      source: opts.source,
      peerId: opts.peerId,
      ts: Date.now(),
      fromRescan: false,
    });

    return result;
  }

  async function rescanPending(): Promise<void> {
    // Snapshot iteration before mutating: attempt()
    // calls may remove entries via sideband.remove, and
    // new entries from concurrent ingest should wait
    // for the next rescan cycle.
    const items = Array.from(sideband.entries());
    for (const [cidStr, data] of items) {
      const ctx = pendingContexts.get(cidStr);
      if (!ctx) continue; // evicted between snapshot + retry.
      const cid = parseCidOrNull(cidStr);
      if (!cid) {
        // Defensive — shouldn't happen. Drop the entry.
        sideband.remove(cidStr);
        pendingContexts.delete(cidStr);
        continue;
      }

      // No eager apply: rescan bypasses the interpreter's
      // tip-selection gate, so we only validate + store
      // bytes. The interpreter rediscovers the CID in its
      // next cycle and applies via the normal tip-advance
      // path (preserving "applyRemote only for tip").
      const result = await attempt(cid, data, ctx, false);

      if (result.outcome === "placed") {
        sideband.remove(cidStr);
        pendingContexts.delete(cidStr);
      } else if (result.outcome === "rejected") {
        // Signature/cid became invalid is basically
        // impossible (bytes haven't changed), but if
        // dedupe now says "applied" (a concurrent
        // applySnapshot got there first), clear the
        // quarantine.
        sideband.remove(cidStr);
        pendingContexts.delete(cidStr);
      }
      // pending: still unplaceable — keep it around.

      emit({
        cid,
        outcome: result.outcome,
        reason: result.reason,
        source: ctx.source,
        peerId: ctx.peerId,
        ts: Date.now(),
        fromRescan: true,
      });
    }
  }

  return {
    ingestSnapshot,
    rescanPending,
    get pendingSize() {
      return sideband.size;
    },
  };
}

// -----------------------------------------------------
// Internals
// -----------------------------------------------------

/**
 * Best-effort CID parse for rescan paths where we hold
 * the stringified form in the sideband.
 */
function parseCidOrNull(cidStr: string): CID | null {
  try {
    return CID.parse(cidStr);
  } catch {
    return null;
  }
}
