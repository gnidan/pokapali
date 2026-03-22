import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";
import { validateSnapshot, decodeSnapshot } from "@pokapali/snapshot";
import { hexToBytes, bytesToHex } from "@pokapali/crypto";
import { ipns } from "@helia/ipns";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { resolveIPNS } from "@pokapali/core/ipns-helpers";
import {
  announceAck,
  announceSnapshot,
  announceTopic,
  verifyAnnouncementProof,
} from "@pokapali/core/announce";
import type { AnnouncePubSub, AnnouncementAck } from "@pokapali/core/announce";
import { createRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import type { HistoryTracker, RetentionConfig } from "./history.js";
import { createIpnsThrottle } from "./ipns-throttle.js";
import {
  createNewNameLimiter,
  DEFAULT_MAX_NEW_NAMES_PER_HOUR,
} from "./new-name-limiter.js";
import { loadState } from "./state.js";
import { createPinnerStore } from "./pinner-store.js";
import type { PinnerStore } from "./pinner-store.js";
import { readFile, writeFile, rename, access } from "node:fs/promises";
import { createLogger } from "@pokapali/log";
import type { Helia } from "helia";

const log = createLogger("pinner");

const RESOLVE_INTERVAL_MS = 5 * 60_000;
const REPUBLISH_INTERVAL_MS = 4 * 60 * 60_000;
const REPUBLISH_CONCURRENCY = 10;
const REPUBLISH_TIMEOUT_MS = 15_000;
// Skip republish if record is <20h old and CID
// unchanged. 24h IPNS TTL minus 4h buffer.
const REPUBLISH_STALE_MS = 20 * 60 * 60_000;
const PERSIST_INTERVAL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 5_000;

// Two-phase guarantee model:
// Phase 1: active re-announcing (load-sensitive, see
//   guaranteeDuration() below)
// Phase 2: block retention (14 days from last activity)
const RETENTION_DURATION_MS = 14 * 24 * 60 * 60_000;

// Version thinning sweep interval (6 hours)
const THIN_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

// Periodic prune interval (1 hour). Runs
// pruneIfNeeded() to deactivate stale docs and
// delete retention-expired docs (#376).
const PRUNE_INTERVAL_MS = 60 * 60_000;

const DEFAULT_RETENTION: RetentionConfig = {
  fullResolutionMs: 7 * 24 * 60 * 60_000,
  hourlyRetentionMs: 14 * 24 * 60 * 60_000,
  dailyRetentionMs: 30 * 24 * 60 * 60_000,
};

// Continuous scheduling constants
const BASE_INTERVAL_MS = 30_000;
const HALF_LIFE_MS = 12 * 60 * 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const SCHEDULE_TICK_MS = 5_000;

// Stale name pruning: drop names with no GossipSub
// activity AND no successful IPNS resolve for 3 days.
const DEFAULT_STALE_RESOLVE_MS = 3 * 24 * 60 * 60_000;

// Self-tuning capacity
const INITIAL_PER_DOC_MS = 50;
const EMA_ALPHA = 0.3;
// Prune metadata when tracking > capacity * 10
const PRUNE_HEADROOM = 10;
// Hard cap on tracked names (OOM protection)
const DEFAULT_MAX_NAMES = 10_000;

export interface PinnerConfig {
  appIds: string[];
  rateLimits?: {
    maxPerHour?: number;
    maxSizeBytes?: number;
  };
  storagePath: string;
  maxConnections?: number;
  helia?: Helia;
  /** PubSub for publishing ack messages. */
  pubsub?: AnnouncePubSub;
  /** Stable peer ID for ack attribution. */
  peerId?: string;
  /** Version retention tiers for thinning. */
  retentionConfig?: RetentionConfig;
  /** Max IPNS requests per second to delegated
   * routing. Default: 10. */
  ipnsRateLimit?: number;
  /** Drop names with no GossipSub activity and no
   * successful IPNS resolve after this many days.
   * Default: 3. Set to 0 to disable. */
  staleResolveDays?: number;
  /** Hard cap on tracked IPNS names. New
   * announcements for unknown names are dropped when
   * at capacity. Default: 10 000. */
  maxNames?: number;
  /** Max new IPNS names admitted per hour. Global
   * rate limit to prevent name-flooding abuse.
   * Default: 100. Set to 0 to reject all new names. */
  maxNewNamesPerHour?: number;
}

export interface PinnerMetrics {
  knownNames: number;
  tipsTracked: number;
  acksTracked: number;
  snapshotsIngested: number;
  rateLimitRejects: number;
  capacityRejects: number;
  newNameRejects: number;
  reannounceCount: number;
  lastReannounceMs: number;
  lastPersistMs: number;
  stateWriteCount: number;
  ipnsThrottleAcquired: number;
  ipnsThrottleRejected: number;
  stalePruned: number;
  staleDeactivated: number;
  deactivatedNames: number;
}

export interface TipData {
  ipnsName: string;
  cid: string;
  block: Uint8Array;
  seq: number;
  ts: number;
  peerId: string;
  guaranteeUntil: number;
  retainUntil: number;
}

export interface GuaranteeData {
  ipnsName: string;
  cid: string;
  peerId: string;
  guaranteeUntil: number;
  retainUntil: number;
}

export interface Pinner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Await all pending background work. */
  flush(): Promise<void>;
  ingest(ipnsName: string, block: Uint8Array): Promise<boolean>;
  onAnnouncement(
    ipnsName: string,
    cidStr: string,
    appId?: string,
    blockData?: Uint8Array,
    fromPinner?: boolean,
    proof?: string,
  ): void;
  onGuaranteeQuery(ipnsName: string, appId: string): void;
  /** Get tip block + guarantee for HTTP endpoint. */
  getTipData(ipnsName: string): Promise<TipData | null>;
  /** Get guarantee status for HTTP endpoint. */
  getGuarantee(ipnsName: string): GuaranteeData | null;
  /** Record browser activity (HTTP access). */
  recordActivity(ipnsName: string): void;
  metrics(): PinnerMetrics;
  history: HistoryTracker;
}

/** Pinner lifecycle phases. Transitions are
 * one-way: created → running → stopped. */
type PinnerPhase = "created" | "running" | "stopped";

export async function createPinner(config: PinnerConfig): Promise<Pinner> {
  const DEFAULT_IPNS_RATE_LIMIT = 10;
  const ipnsThrottle = createIpnsThrottle(
    config.ipnsRateLimit ?? DEFAULT_IPNS_RATE_LIMIT,
  );
  const newNameLimiter = createNewNameLimiter(
    config.maxNewNamesPerHour ?? DEFAULT_MAX_NEW_NAMES_PER_HOUR,
  );

  const rateLimits: RateLimiterConfig = {
    maxSnapshotsPerHour:
      config.rateLimits?.maxPerHour ?? DEFAULT_RATE_LIMITS.maxSnapshotsPerHour,
    maxBlockSizeBytes:
      config.rateLimits?.maxSizeBytes ?? DEFAULT_RATE_LIMITS.maxBlockSizeBytes,
  };
  const rateLimiter = createRateLimiter(rateLimits);
  const history = createHistoryTracker();
  const storePath = config.storagePath + "/pinner-state";
  const statePath = config.storagePath + "/state.json";
  const historyIndexPath = config.storagePath + "/history-index.json";
  const helia = config.helia;
  const retention = config.retentionConfig ?? DEFAULT_RETENTION;
  const store: PinnerStore = await createPinnerStore(storePath);
  await store.open();

  // In-memory block store as fallback when no Helia
  const memBlocks = new Map<string, Uint8Array>();
  const knownNames = new Set<string>();
  // Track last acked CID per ipnsName to avoid
  // redundant fetch+ack cycles on re-announces.
  const lastAckedCid = new Map<string, string>();
  // Map ipnsName → appId for re-announcing.
  const nameToAppId = new Map<string, string>();
  // Last activity timestamp per doc (writer or reader
  // announcement, NOT pinner re-announce).
  const lastSeenAt = new Map<string, number>();
  // Monotonic guarantee tracking per ipnsName.
  // Not persisted — fresh guarantees after restart.
  const guaranteedUntil = new Map<string, number>();
  // Rate-limit guarantee query responses:
  // max 1 response per ipnsName per 3s.
  const lastQueryResponse = new Map<string, number>();
  const QUERY_RESPONSE_COOLDOWN_MS = 3_000;
  // Last successful IPNS resolve per name.
  // Persisted in LevelDB for stale pruning.
  const lastResolvedAt = new Map<string, number>();
  // Stale resolve threshold (0 = disabled)
  const staleResolveMs =
    config.staleResolveDays === 0
      ? 0
      : (config.staleResolveDays ?? 3) * 24 * 60 * 60_000;
  const maxNames = config.maxNames ?? DEFAULT_MAX_NAMES;
  // Names in passive phase — blocks retained,
  // announcements stopped. Persisted in LevelDB (#376).
  const deactivatedNames = new Set<string>();

  // Self-tuning capacity measurement
  let perDocEma = INITIAL_PER_DOC_MS;
  // Count of docs re-announced in last cycle
  let scheduledDocCount = 0;

  // --- Min-heap for re-announce scheduling ---
  interface ScheduledDoc {
    ipnsName: string;
    nextAt: number;
  }
  const heap: ScheduledDoc[] = [];

  function heapPush(doc: ScheduledDoc): void {
    heap.push(doc);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.nextAt <= heap[i]!.nextAt) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  }

  function heapPop(): ScheduledDoc | undefined {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < heap.length && heap[l]!.nextAt < heap[smallest]!.nextAt)
          smallest = l;
        if (r < heap.length && heap[r]!.nextAt < heap[smallest]!.nextAt)
          smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
        i = smallest;
      }
    }
    return top;
  }

  function heapPeek(): ScheduledDoc | undefined {
    return heap[0];
  }

  // Track which docs are in the heap to avoid dupes
  const inHeap = new Set<string>();

  function scheduleDoc(ipnsName: string, nextAt: number): void {
    // Lazy deletion — old entry stays in heap as
    // stale until popped or compacted.
    if (inHeap.has(ipnsName)) stalePushes++;
    heapPush({ ipnsName, nextAt });
    inHeap.add(ipnsName);
  }

  // Track stale pushes so we can compact when the
  // heap grows too large relative to live entries.
  let stalePushes = 0;
  const COMPACT_THRESHOLD = 500;

  function compactHeap(): void {
    // Rebuild heap keeping only the latest entry
    // per ipnsName that is still in knownNames.
    const best = new Map<string, ScheduledDoc>();
    for (const doc of heap) {
      if (!knownNames.has(doc.ipnsName)) continue;
      const existing = best.get(doc.ipnsName);
      if (!existing || doc.nextAt < existing.nextAt) {
        best.set(doc.ipnsName, doc);
      }
    }
    heap.length = 0;
    inHeap.clear();
    for (const doc of best.values()) {
      heapPush(doc);
      inHeap.add(doc.ipnsName);
    }
    stalePushes = 0;
    log.debug(`heap compacted: ${best.size} entries`);
  }

  // --- Continuous interval / capacity ---

  function loadFactor(): number {
    const capacity = maxActiveDocs();
    const utilization = capacity > 0 ? scheduledDocCount / capacity : 1;
    if (utilization <= 0.5) return 1;
    return 1 + 9 * Math.pow((utilization - 0.5) / 0.5, 2);
  }

  function reannounceInterval(ipnsName: string, now: number): number {
    const seen = lastSeenAt.get(ipnsName) ?? 0;
    const age = now - seen;

    // Past retention window — don't re-announce
    if (age >= RETENTION_DURATION_MS) {
      return MAX_INTERVAL_MS;
    }

    const recencyFactor = Math.pow(2, age / HALF_LIFE_MS);
    const interval = BASE_INTERVAL_MS * recencyFactor * loadFactor();
    return Math.min(interval, MAX_INTERVAL_MS);
  }

  function maxActiveDocs(): number {
    return Math.max(1, Math.floor((BASE_INTERVAL_MS * 0.8) / perDocEma));
  }

  const DAY = 24 * 60 * 60_000;

  function guaranteeDuration(): number {
    const util = scheduledDocCount / maxActiveDocs();
    if (util <= 0.5) return 7 * DAY;
    if (util <= 0.7) return 5 * DAY;
    if (util <= 0.9) return 3 * DAY;
    return 1 * DAY;
  }

  function issueGuarantee(ipnsName: string): {
    guaranteeUntil: number;
    retainUntil: number;
  } {
    const seen = lastSeenAt.get(ipnsName) ?? Date.now();
    const calculated = seen + guaranteeDuration();
    const existing = guaranteedUntil.get(ipnsName) ?? 0;
    // Monotonic: never shorten a promise
    const guarantee = Math.max(calculated, existing);
    guaranteedUntil.set(ipnsName, guarantee);
    return {
      guaranteeUntil: guarantee,
      retainUntil: seen + RETENTION_DURATION_MS,
    };
  }

  // Track fire-and-forget async work so tests (and
  // graceful shutdown) can await completion.
  const pending = new Set<Promise<unknown>>();
  function track(p: Promise<unknown>): void {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  let phase: PinnerPhase = "created";
  // Gate stale-resolve pruning on resolveAll() having
  // completed at least once (#378). On restart,
  // lastResolvedAt is stale until resolveAll() runs.
  let resolveAllCompleted = false;
  const shutdownCtrl = new AbortController();
  let resolveInterval: ReturnType<typeof setInterval> | null = null;
  let republishInterval: ReturnType<typeof setInterval> | null = null;
  let initialRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduleInterval: ReturnType<typeof setInterval> | null = null;
  let persistInterval: ReturnType<typeof setInterval> | null = null;
  let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let thinSweepInterval: ReturnType<typeof setInterval> | null = null;
  let pruneInterval: ReturnType<typeof setInterval> | null = null;
  let dirty = false;

  // Counters for /metrics endpoint
  let snapshotsIngested = 0;
  let rateLimitRejects = 0;
  let capacityRejects = 0;
  let newNameRejects = 0;
  let reannounceCount = 0;
  let lastReannounceMs = 0;
  let lastPersistMs = 0;
  let stateWriteCount = 0;
  let stalePruned = 0;
  let staleDeactivated = 0;

  /** Write-through: persist a state mutation to
   * LevelDB. Fire-and-forget safe for sync callers
   * like onAnnouncement. */
  function persistMutation(fn: () => Promise<void>): void {
    track(
      fn().catch((err) => {
        log.warn("store write failed:", err);
      }),
    );
  }

  function markDirty(): void {
    dirty = true;
    // Debounce: persist history index within 5s
    if (persistDebounceTimer) {
      clearTimeout(persistDebounceTimer);
    }
    persistDebounceTimer = setTimeout(() => {
      persistDebounceTimer = null;
      if (dirty && phase === "running") {
        dirty = false;
        persistHistoryIndex().catch((err) => {
          log.warn("debounced history persist failed:", err);
        });
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  async function storeBlock(cid: CID, block: Uint8Array): Promise<void> {
    if (helia) {
      await helia.blockstore.put(cid, block);
    } else {
      memBlocks.set(cid.toString(), block);
    }
  }

  /**
   * Fetch a block by CID directly (no IPNS resolve).
   * Used when we already know the CID from an
   * announcement.
   */
  async function fetchByCid(
    ipnsName: string,
    cidStr: string,
    blockData?: Uint8Array,
  ): Promise<boolean> {
    if (!helia) return false;

    try {
      const tipCid = history.getTip(ipnsName);
      if (tipCid === cidStr) {
        return true; // Already have latest
      }

      const cid = CID.parse(cidStr);

      // Use provided block data directly if
      // available, avoiding blockstore race.
      let block: Uint8Array;
      if (blockData) {
        block = blockData;
      } else {
        block = await helia.blockstore.get(cid, {
          signal: AbortSignal.timeout(30_000),
        });
      }

      const valid = await validateSnapshot(block);
      if (!valid) {
        try {
          decodeSnapshot(block);
          log.warn(
            `block decode OK but validate failed` +
              ` ${ipnsName.slice(0, 12)}...` +
              ` blockSize=${block.length}`,
          );
        } catch (decodeErr) {
          log.warn(
            `block decode failed` +
              ` ${ipnsName.slice(0, 12)}...` +
              ` blockSize=${block.length}` +
              ` err=${(decodeErr as Error).message}`,
          );
        }
        return false;
      }

      const node = decodeSnapshot(block);

      // Verify publicKey↔ipnsName binding (#76):
      // ipnsName is the hex-encoded Ed25519 public key
      // of the document. Reject snapshots signed by a
      // different key to prevent overwrite attacks.
      const expectedKey = hexToBytes(ipnsName);
      if (
        node.publicKey.length !== expectedKey.length ||
        !node.publicKey.every((b, i) => b === expectedKey[i])
      ) {
        log.warn(
          `publicKey mismatch for` +
            ` ${ipnsName.slice(0, 12)}...:` +
            ` expected=${ipnsName.slice(0, 16)}` +
            ` got=${bytesToHex(node.publicKey).slice(0, 16)}`,
        );
        return false;
      }

      // Store block only after validation passes
      if (blockData) {
        await helia.blockstore.put(cid, blockData);
      }

      knownNames.add(ipnsName);
      history.add(ipnsName, cid, node.ts);
      persistMutation(async () => {
        await store.addName(ipnsName);
        await store.setTip(ipnsName, cid.toString());
      });
      markDirty();
      log.debug(
        `fetched block for` +
          ` ${ipnsName.slice(0, 12)}...` +
          ` cid=${cidStr.slice(0, 12)}...`,
      );
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(
        `fetch failed for` +
          ` ${ipnsName.slice(0, 12)}...` +
          ` cid=${cidStr.slice(0, 12)}...: ${msg}`,
      );
      return false;
    }
  }

  /**
   * Resolve IPNS name and fetch the block. Used for
   * periodic re-resolution and startup recovery.
   *
   * Uses delegated HTTP routing first (fast), then
   * falls back to DHT — same path browsers use.
   */
  async function resolveAndFetch(ipnsName: string): Promise<boolean> {
    if (!helia) return false;

    try {
      // Best-effort throttle: skip if no token
      // available. IPNS resolve is supplementary —
      // GossipSub is the primary notification path.
      if (!ipnsThrottle.tryAcquire()) {
        log.debug(`resolve throttled:` + ` ${ipnsName.slice(0, 12)}...`);
        return false;
      }

      const keyBytes = hexToBytes(ipnsName);
      const cid = await resolveIPNS(helia, keyBytes);
      if (!cid) {
        log.error(`resolve returned null for` + ` ${ipnsName.slice(0, 12)}...`);
        return false;
      }

      // Record successful resolve for stale pruning
      const now = Date.now();
      lastResolvedAt.set(ipnsName, now);
      persistMutation(() => store.setLastResolved(ipnsName, now));

      log.debug(
        `resolved ${ipnsName.slice(0, 12)}...` +
          ` -> ${cid.toString().slice(0, 12)}...`,
      );

      return fetchByCid(ipnsName, cid.toString());
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(`resolve failed for` + ` ${ipnsName.slice(0, 12)}...: ${msg}`);
      return false;
    }
  }

  async function resolveAll(): Promise<void> {
    const now = Date.now();
    const names = [...knownNames].filter(
      (n) =>
        !deactivatedNames.has(n) &&
        reannounceInterval(n, now) < MAX_INTERVAL_MS,
    );
    if (names.length === 0) return;
    log.debug(
      `re-resolving ${names.length}/${knownNames.size}` + ` scheduled names`,
    );
    // Batch to avoid OOM from unbounded concurrency
    const BATCH_SIZE = 10;
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      if (phase === "stopped") break;
      const batch = names.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((n) => resolveAndFetch(n)));
    }
  }

  /**
   * Re-put existing IPNS records to keep them alive
   * on the DHT. No private key needed — records are
   * already signed by writers. Uses @helia/ipns
   * republishRecord which goes through Helia's
   * composed routing (DHT on node side).
   */
  // Track last successful republish time per name
  const lastRepublished = new Map<string, number>();
  // Track CID at last successful republish
  const lastRepublishedCid = new Map<string, string>();

  /**
   * Republish a single IPNS record. Uses combined
   * signal: per-call timeout + shutdown abort so the
   * process doesn't hang on stop().
   */
  async function republishOne(ipnsName: string): Promise<"ok" | "fail"> {
    if (!helia) return "fail";
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(REPUBLISH_TIMEOUT_MS),
        shutdownCtrl.signal,
      ]);

      // Throttle IPNS requests to avoid overwhelming
      // delegated-ipfs.dev at scale.
      await ipnsThrottle.acquire(signal);

      const name = ipns(helia);
      const keyBytes = hexToBytes(ipnsName);
      const pubKey = publicKeyFromRaw(keyBytes);

      const result = await name.resolve(pubKey, { signal });

      await name.republishRecord(pubKey.toMultihash(), result.record, {
        signal,
      });

      // Track successful republish
      const now = Date.now();
      lastRepublished.set(ipnsName, now);
      const tip = history.getTip(ipnsName);
      if (tip) lastRepublishedCid.set(ipnsName, tip);

      log.debug(`republished IPNS for` + ` ${ipnsName.slice(0, 12)}...`);
      return "ok";
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(
        `IPNS republish failed for` +
          ` ${ipnsName.slice(0, 12)}...:` +
          ` ${msg}`,
      );
      return "fail";
    }
  }

  /**
   * Select names that need republishing this cycle.
   * Skips names whose record is <20h old with
   * unchanged CID (5x fewer DHT ops for stable docs).
   */
  function getRepublishCandidates(): string[] {
    const now = Date.now();
    const candidates: string[] = [];

    for (const ipnsName of knownNames) {
      // Skip deactivated names (passive phase)
      if (deactivatedNames.has(ipnsName)) continue;
      const seen = lastSeenAt.get(ipnsName) ?? 0;
      // Skip names past retention
      if (seen + RETENTION_DURATION_MS <= now) continue;

      const lastPub = lastRepublished.get(ipnsName) ?? 0;
      const tip = history.getTip(ipnsName);
      const lastPubCid = lastRepublishedCid.get(ipnsName);

      // Always republish if CID changed
      if (tip && tip !== lastPubCid) {
        candidates.push(ipnsName);
        continue;
      }

      // Republish if record is stale (>20h since
      // last publish, approaching 24h TTL expiry)
      if (now - lastPub > REPUBLISH_STALE_MS) {
        candidates.push(ipnsName);
        continue;
      }

      // Otherwise skip — record is fresh enough
    }

    return candidates;
  }

  async function republishAllIPNS(): Promise<void> {
    if (!helia) return;

    const candidates = getRepublishCandidates();
    const retained = [...knownNames].filter((n) => {
      const seen = lastSeenAt.get(n) ?? 0;
      return seen + RETENTION_DURATION_MS > Date.now();
    }).length;
    const skip = retained - candidates.length;

    if (candidates.length === 0) {
      log.info(
        `IPNS republish: 0 candidates` +
          ` (${skip} skipped, ${retained} retained)`,
      );
      return;
    }

    const start = Date.now();
    log.info(
      `republishing IPNS for` +
        ` ${candidates.length}/${retained}` +
        ` retained names` +
        ` (${skip} skipped,` +
        ` concurrency=${REPUBLISH_CONCURRENCY})`,
    );

    let idx = 0;
    let ok = 0;
    let fail = 0;
    let abortCycle = false;

    async function worker(): Promise<void> {
      while (phase === "running" && !abortCycle) {
        const i = idx++;
        if (i >= candidates.length) return;
        const result = await republishOne(candidates[i]!);
        if (result === "ok") ok++;
        else fail++;

        // Circuit breaker: abort if >50% failure
        // rate after 20+ attempts
        const total = ok + fail;
        if (total >= 20 && fail / total > 0.5) {
          log.warn(
            `IPNS republish: >50% failure rate` +
              ` (${fail}/${total}),` +
              ` aborting cycle`,
          );
          abortCycle = true;
          return;
        }
      }
    }

    const workers = Array.from(
      {
        length: Math.min(REPUBLISH_CONCURRENCY, candidates.length),
      },
      () => worker(),
    );
    await Promise.allSettled(workers);

    const elapsed = Date.now() - start;
    log.info(
      `IPNS republish done:` +
        ` ${ok} ok, ${fail} failed,` +
        ` ${skip} skipped` +
        ` in ${elapsed}ms` +
        ` (${
          candidates.length > 0 ? (elapsed / candidates.length).toFixed(0) : 0
        }ms/name)`,
    );
  }

  /**
   * Process due docs from the priority queue.
   * Called on a timer; pops docs whose nextAt has
   * passed, re-announces them, and reschedules with
   * a new interval based on recency and load.
   */
  async function processScheduleQueue(): Promise<void> {
    if (!helia || !config.pubsub) return;
    const start = Date.now();
    let count = 0;

    while (heap.length > 0 && phase === "running") {
      const top = heapPeek()!;
      if (top.nextAt > start) break;

      heapPop();

      // Skip if doc was removed, stale, or
      // deactivated (passive phase)
      if (!knownNames.has(top.ipnsName) || deactivatedNames.has(top.ipnsName)) {
        inHeap.delete(top.ipnsName);
        continue;
      }

      const ipnsName = top.ipnsName;
      const appId = nameToAppId.get(ipnsName);
      if (!appId) continue;
      const cidStr = history.getTip(ipnsName);
      if (!cidStr) continue;

      try {
        // No inline block — peers fetch if needed.
        // fromPinner: true so other pinners don't
        // refresh lastSeenAt (prevents keep-alive
        // loop between pinners).
        // Embed ack with guarantee so browsers see
        // retention info on first message.
        const ack: AnnouncementAck | undefined = config.peerId
          ? {
              peerId: config.peerId,
              ...issueGuarantee(ipnsName),
            }
          : undefined;
        await announceSnapshot(
          config.pubsub,
          appId,
          ipnsName,
          cidStr,
          undefined,
          undefined,
          true,
          ack,
        );
        count++;
        log.debug(
          `re-announced` +
            ` ${ipnsName.slice(0, 12)}...` +
            ` cid=${cidStr.slice(0, 12)}...`,
        );
      } catch (err) {
        log.warn(`re-announce failed` + ` ${ipnsName.slice(0, 12)}...:`, err);
      }

      // Reschedule with new interval
      const now = Date.now();
      const interval = reannounceInterval(ipnsName, now);
      if (interval < MAX_INTERVAL_MS) {
        scheduleDoc(ipnsName, now + interval);
      } else {
        inHeap.delete(ipnsName);
      }
    }

    if (count > 0) {
      reannounceCount++;
      const elapsed = Date.now() - start;
      lastReannounceMs = elapsed;
      scheduledDocCount = inHeap.size;

      // Update capacity EMA
      const measured = elapsed / count;
      perDocEma = EMA_ALPHA * measured + (1 - EMA_ALPHA) * perDocEma;

      log.debug(
        `reannounce: ${count} docs in ${elapsed}ms` +
          ` (${measured.toFixed(1)}ms/doc,` +
          ` capacity=${maxActiveDocs()},` +
          ` scheduled=${inHeap.size})`,
      );
    }

    // Compact heap when stale entries accumulate
    if (stalePushes >= COMPACT_THRESHOLD) {
      compactHeap();
    }
  }

  /**
   * Deactivate a name: stop announcing and
   * republishing, but keep blocks and metadata.
   * The doc enters "passive" phase (#376).
   */
  function deactivateName(name: string): void {
    deactivatedNames.add(name);
    inHeap.delete(name);
    guaranteedUntil.delete(name);
    persistMutation(() => store.setDeactivated(name));
    log.info(`deactivated ${name.slice(0, 12)}...` + ` (passive retention)`);
  }

  /**
   * Prune docs past retention (14 days of inactivity).
   * Stale names within retention are deactivated, not
   * deleted (#376). Capacity backstop still deletes
   * (OOM protection).
   */
  async function pruneIfNeeded(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];
    const toDeactivate: string[] = [];

    // Primary: time-based retention pruning → DELETE
    for (const name of knownNames) {
      const seen = lastSeenAt.get(name) ?? 0;
      if (seen + RETENTION_DURATION_MS < now) {
        toDelete.push(name);
      }
    }

    // Stale-resolve pruning → DEACTIVATE (not delete)
    //
    // Gate on resolveAll() completion (#378, replaces
    // #376 time-based grace). On restart, lastResolvedAt
    // is stale until resolveAll() populates it. Without
    // this gate, every doc looks stale and gets
    // deactivated.
    //
    // First-run grace: names that have NEVER been
    // resolved (lastResolvedAt=0, new field) use a
    // shorter 12h threshold.
    const NEVER_RESOLVED_GRACE_MS = 12 * 60 * 60_000;
    if (!resolveAllCompleted && staleResolveMs > 0) {
      log.info(
        "skipping stale-resolve pruning:" +
          " resolveAll() has not completed yet",
      );
    }
    if (staleResolveMs > 0 && resolveAllCompleted) {
      const deleteSet = new Set(toDelete);
      for (const name of knownNames) {
        if (deleteSet.has(name)) continue;
        if (deactivatedNames.has(name)) continue;
        const seen = lastSeenAt.get(name) ?? 0;
        const resolved = lastResolvedAt.get(name) ?? 0;
        if (resolved === 0) {
          const seenStale = seen + NEVER_RESOLVED_GRACE_MS < now;
          if (seenStale) {
            toDeactivate.push(name);
          }
        } else {
          const seenStale = seen + staleResolveMs < now;
          const resolveStale = resolved + staleResolveMs < now;
          if (seenStale && resolveStale) {
            toDeactivate.push(name);
          }
        }
      }
    }

    // Capacity backstop → DELETE (OOM protection)
    const pending = knownNames.size - toDelete.length;
    const maxTracked = maxActiveDocs() * PRUNE_HEADROOM;
    if (pending > maxTracked) {
      const deleteSet = new Set(toDelete);
      const sorted = [...knownNames]
        .filter((n) => !deleteSet.has(n))
        .map((n) => ({
          name: n,
          seen: lastSeenAt.get(n) ?? 0,
        }))
        .sort((a, b) => a.seen - b.seen);
      const extra = sorted.slice(0, pending - maxTracked);
      for (const { name } of extra) {
        toDelete.push(name);
      }
    }

    // Execute deactivations (soft — keep blocks)
    for (const name of toDeactivate) {
      deactivateName(name);
    }
    if (toDeactivate.length > 0) {
      staleDeactivated += toDeactivate.length;
    }

    // Execute deletions (hard — remove blocks)
    for (const name of toDelete) {
      const entry = history.getEntry(name);
      if (entry && helia) {
        for (const snap of entry.snapshots) {
          try {
            const cid = CID.parse(snap.cid);
            await helia.blockstore.delete(cid);
          } catch {
            // Block already missing — fine
          }
        }
      } else if (entry) {
        for (const snap of entry.snapshots) {
          memBlocks.delete(snap.cid);
        }
      }

      knownNames.delete(name);
      lastSeenAt.delete(name);
      lastAckedCid.delete(name);
      nameToAppId.delete(name);
      lastResolvedAt.delete(name);
      lastQueryResponse.delete(name);
      persistMutation(() => store.removeName(name));
      guaranteedUntil.delete(name);
      inHeap.delete(name);
      deactivatedNames.delete(name);
    }

    if (toDelete.length > 0) {
      stalePruned += toDelete.length;
    }
    if (toDelete.length > 0 || toDeactivate.length > 0) {
      markDirty();
      const parts: string[] = [];
      if (toDelete.length > 0) {
        parts.push(`deleted ${toDelete.length}`);
      }
      if (toDeactivate.length > 0) {
        parts.push(`deactivated ${toDeactivate.length}`);
      }
      parts.push(`${knownNames.size} remaining`);
      log.info(`prune: ${parts.join(", ")}`);
    }
  }

  async function loadHistoryIndex(): Promise<boolean> {
    try {
      const raw = await readFile(historyIndexPath, "utf-8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        history.loadJSON(data);
        log.info(
          `loaded history index:` + ` ${history.allNames().length} names`,
        );
        return true;
      }
    } catch {
      // No index file or corrupt — will backfill
    }
    return false;
  }

  async function saveHistoryIndex(): Promise<void> {
    await writeFile(
      historyIndexPath,
      JSON.stringify(history.toJSON()),
      "utf-8",
    );
  }

  async function migrateFromStateJson(): Promise<boolean> {
    try {
      await access(statePath);
    } catch {
      return false; // No state.json — nothing to migrate
    }

    const state = await loadState(statePath);
    if (state.knownNames.length === 0) return false;

    log.info(
      `migrating ${state.knownNames.length} names` +
        ` from state.json to LevelDB`,
    );
    await store.importState(state);

    // Rename to .bak so we don't re-migrate
    const bakPath = statePath + ".bak";
    await rename(statePath, bakPath);
    log.info(`state.json renamed to state.json.bak`);
    return true;
  }

  async function restoreState(): Promise<void> {
    // Check if LevelDB store has data
    let names = await store.getNames();
    if (names.size === 0) {
      // Try migrating from state.json
      await migrateFromStateJson();
      names = await store.getNames();
    }

    for (const n of names) {
      knownNames.add(n);
    }

    // Try loading persisted history index first.
    // If available, it has full chain history.
    const hasIndex = await loadHistoryIndex();

    const tips = await store.getTips();
    const seenMap = await store.getLastSeenAll();
    const appMap = await store.getAppIds();
    const resMap = await store.getLastResolvedAll();

    for (const [name, cidStr] of tips) {
      const ts = seenMap.get(name) ?? 0;
      history.add(name, CID.parse(cidStr), ts);
    }
    for (const [name, appId] of appMap) {
      nameToAppId.set(name, appId);
    }
    for (const [name, ts] of seenMap) {
      lastSeenAt.set(name, ts);
    }
    for (const [name, ts] of resMap) {
      lastResolvedAt.set(name, ts);
    }
    // Load deactivated names (#376)
    const deactNames = await store.getDeactivatedNames();
    for (const name of deactNames) {
      if (knownNames.has(name)) {
        deactivatedNames.add(name);
      }
    }
    // Backfill lastSeenAt for names that don't have
    // it — use 0 so they get pruned on next cycle.
    for (const name of knownNames) {
      if (!lastSeenAt.has(name)) {
        lastSeenAt.set(name, 0);
        persistMutation(() => store.setLastSeen(name, 0));
      }
    }
    // Seed the schedule queue from restored state
    // (skip deactivated names — passive phase)
    const now = Date.now();
    for (const name of knownNames) {
      if (deactivatedNames.has(name)) continue;
      const interval = reannounceInterval(name, now);
      if (interval < MAX_INTERVAL_MS) {
        scheduleDoc(name, now + interval);
      }
    }
  }

  const BACKFILL_CONCURRENCY = 10;

  /**
   * Walk the snapshot chain from each tip CID to
   * populate the history tracker with all blocks
   * in the local blockstore. Runs as background
   * task — does not block startup.
   */
  async function backfillHistory(): Promise<void> {
    if (!helia) return;

    // Collect names that need backfill: those where
    // history only has 1 entry (the tip from state)
    // and the tip block has a prev pointer.
    const candidates: Array<{
      name: string;
      tipCid: string;
    }> = [];
    for (const name of knownNames) {
      const entries = history.getHistory(name);
      const tip = history.getTip(name);
      // Only backfill if we have exactly 1 entry
      // (the tip). If index was loaded, names with
      // full history will have >1 entries already.
      if (tip && entries.length <= 1) {
        candidates.push({ name, tipCid: tip });
      }
    }

    if (candidates.length === 0) return;
    log.info(`backfill: walking chains for` + ` ${candidates.length} names`);

    let walked = 0;
    let blocksFound = 0;
    let errors = 0;
    let idx = 0;

    async function worker(): Promise<void> {
      while (true) {
        const i = idx++;
        if (i >= candidates.length) break;
        const { name, tipCid } = candidates[i]!;
        try {
          const cid = CID.parse(tipCid);
          // Read the tip block to find prev pointer
          let current: CID | null = cid;
          // Skip the tip itself (already in history)
          const tipBlock = await helia!.blockstore.get(current);
          const tipNode = decodeSnapshot(tipBlock);
          current = tipNode.prev;

          // Walk backwards through the chain
          while (current !== null) {
            if (phase === "stopped") return;
            try {
              const has = await helia!.blockstore.has(current);
              if (!has) break; // block not in store
              const block = await helia!.blockstore.get(current);
              const node = decodeSnapshot(block);
              history.add(name, current, node.ts);
              blocksFound++;
              current = node.prev;
            } catch {
              break; // corrupt or missing block
            }
          }
          walked++;
        } catch {
          errors++;
        }
      }
    }

    const workers = Array.from({ length: BACKFILL_CONCURRENCY }, () =>
      worker(),
    );
    await Promise.allSettled(workers);

    log.info(
      `backfill done: ${walked} chains,` +
        ` ${blocksFound} blocks found,` +
        ` ${errors} errors`,
    );

    // Persist updated history index
    if (blocksFound > 0) {
      try {
        await saveHistoryIndex();
        log.info("backfill: history index saved");
      } catch (err) {
        log.warn("backfill: index save failed:", (err as Error).message);
      }
    }
  }

  /**
   * Thin version history for a single doc: keep tip,
   * one-per-hour in hourly tier, one-per-day in daily
   * tier, prune beyond daily retention. Deletes
   * removed blocks from blockstore.
   */
  async function thinVersionHistory(ipnsName: string): Promise<number> {
    const removed = history.thinSnapshots(ipnsName, retention);
    if (removed.length === 0) return 0;

    if (helia) {
      for (const cid of removed) {
        try {
          await helia.blockstore.delete(cid);
        } catch {
          // Block already missing — fine
        }
      }
    } else {
      for (const cid of removed) {
        memBlocks.delete(cid.toString());
      }
    }
    markDirty();
    return removed.length;
  }

  /**
   * Sweep all known names, thinning version history.
   * Runs periodically (every 6h).
   */
  async function thinSweep(): Promise<void> {
    let totalRemoved = 0;
    for (const name of knownNames) {
      if (phase === "stopped") break;
      totalRemoved += await thinVersionHistory(name);
    }
    if (totalRemoved > 0) {
      log.info(
        `thin sweep: removed ${totalRemoved} blocks` +
          ` across ${knownNames.size} docs`,
      );
    }
  }

  async function persistHistoryIndex(): Promise<void> {
    const start = Date.now();
    try {
      await saveHistoryIndex();
    } catch (err) {
      log.warn("history index save failed:", (err as Error).message);
    }
    lastPersistMs = Date.now() - start;
    stateWriteCount++;
  }

  function processAnnouncement(
    ipnsName: string,
    cidStr: string,
    appId?: string,
    blockData?: Uint8Array,
    fromPinner?: boolean,
  ): void {
    // Admission gate: reject unknown names at capacity
    // or when new-name rate limit is exceeded.
    if (!knownNames.has(ipnsName)) {
      if (knownNames.size >= maxNames) {
        capacityRejects++;
        return;
      }
      if (!newNameLimiter.tryAdmit()) {
        newNameRejects++;
        return;
      }
    }

    knownNames.add(ipnsName);
    if (appId) nameToAppId.set(ipnsName, appId);
    persistMutation(async () => {
      await store.addName(ipnsName);
      if (appId) await store.setAppId(ipnsName, appId);
    });

    // Only refresh lastSeenAt for non-pinner
    // announcements (writer/reader activity).
    // Pinner re-announces are supply signals and
    // must NOT keep docs alive indefinitely.
    if (!fromPinner) {
      const now = Date.now();
      lastSeenAt.set(ipnsName, now);
      persistMutation(() => store.setLastSeen(ipnsName, now));
      // Reactivate if deactivated (#376)
      if (deactivatedNames.has(ipnsName)) {
        deactivatedNames.delete(ipnsName);
        persistMutation(() => store.clearDeactivated(ipnsName));
        log.info(
          `reactivated` + ` ${ipnsName.slice(0, 12)}...` + ` (new activity)`,
        );
      }
      // Reset monotonic guarantee on new activity
      // so it recalculates from fresh lastSeenAt.
      guaranteedUntil.delete(ipnsName);
    }

    // Dedup: if we already fetched+acked this CID,
    // just re-ack (cheap) so new browsers see it.
    if (lastAckedCid.get(ipnsName) === cidStr) {
      log.debug(`duplicate: ${cidStr.slice(0, 12)}...` + ` re-acking`);
      if (appId && config.pubsub && config.peerId) {
        const g = issueGuarantee(ipnsName);
        track(
          announceAck(
            config.pubsub,
            appId,
            ipnsName,
            cidStr,
            config.peerId,
            g.guaranteeUntil,
            g.retainUntil,
          ).catch((err) => {
            log.warn("re-ack failed:", err);
          }),
        );
      }
      return;
    }

    log.debug(
      `announcement: name=${ipnsName.slice(0, 12)}...` +
        ` cid=${cidStr.slice(0, 12)}...`,
    );
    // New CID supersedes old guarantee
    guaranteedUntil.delete(ipnsName);

    // Fetch the announced CID directly (don't
    // re-resolve IPNS — the announcement has the
    // latest CID, IPNS may lag behind).
    if (helia) {
      track(
        fetchByCid(ipnsName, cidStr, blockData)
          .then(async (ok) => {
            if (ok && appId && config.pubsub && config.peerId) {
              const g = issueGuarantee(ipnsName);
              await announceAck(
                config.pubsub,
                appId,
                ipnsName,
                cidStr,
                config.peerId,
                g.guaranteeUntil,
                g.retainUntil,
              );
              lastAckedCid.set(ipnsName, cidStr);
              // Thin old versions after new ingest
              await thinVersionHistory(ipnsName);
              markDirty();
              log.debug(
                `acked` +
                  ` ${ipnsName.slice(0, 12)}...` +
                  ` cid=${cidStr.slice(0, 12)}...`,
              );
            } else {
              log.debug(
                `ack skipped:` +
                  ` ok=${ok}` +
                  ` appId=${appId}` +
                  ` pubsub=${!!config.pubsub}` +
                  ` peerId=${!!config.peerId}`,
              );
            }
          })
          .catch((err) => {
            log.warn(
              `ack failed:` +
                ` ${ipnsName.slice(0, 12)}...` +
                ` cid=${cidStr.slice(0, 12)}...:`,
              err,
            );
          }),
      );
    }

    // Schedule for re-announce
    const now = Date.now();
    const interval = reannounceInterval(ipnsName, now);
    if (interval < MAX_INTERVAL_MS) {
      scheduleDoc(ipnsName, now + interval);
    }
  }

  return {
    history,

    metrics(): PinnerMetrics {
      const tm = ipnsThrottle.metrics();
      return {
        knownNames: knownNames.size,
        tipsTracked: history.allNames().length,
        acksTracked: lastAckedCid.size,
        snapshotsIngested,
        rateLimitRejects,
        capacityRejects,
        newNameRejects,
        reannounceCount,
        lastReannounceMs,
        lastPersistMs,
        stateWriteCount,
        ipnsThrottleAcquired: tm.acquired,
        ipnsThrottleRejected: tm.rejected,
        stalePruned,
        staleDeactivated,
        deactivatedNames: deactivatedNames.size,
      };
    },

    async flush(): Promise<void> {
      await Promise.allSettled([...pending]);
    },

    async start(): Promise<void> {
      if (phase !== "created") {
        throw new Error(
          `pinner.start() called in phase "${phase}"` + ` (expected "created")`,
        );
      }
      try {
        await restoreState();
      } catch (err) {
        await store.close().catch((closeErr) => {
          log.warn(
            "store close failed during error" + " recovery:",
            (closeErr as Error)?.message ?? closeErr,
          );
        });
        throw err;
      }
      await pruneIfNeeded();

      // Backfill history index from blockstore
      // chains. Fire and forget — doesn't block.
      if (helia && knownNames.size > 0) {
        track(backfillHistory());
      }

      // Resolve all persisted names on startup.
      // Sets resolveAllCompleted so stale-resolve
      // pruning can fire (#378).
      if (helia && knownNames.size > 0) {
        log.info(`startup: resolving` + ` ${knownNames.size} persisted names`);
        // Fire and forget — don't block startup
        track(
          resolveAll().then(() => {
            resolveAllCompleted = true;
            log.info(
              "resolveAll() complete," + " stale-resolve pruning enabled",
            );
          }),
        );
      } else {
        // No names to resolve — stale-resolve can
        // fire immediately (nothing to stale-prune)
        resolveAllCompleted = true;
      }

      phase = "running";

      // Periodic prune: deactivate stale docs,
      // delete retention-expired docs (#376/#378).
      // Stale-resolve gated on resolveAllCompleted.
      pruneInterval = setInterval(() => {
        if (phase === "running") {
          track(pruneIfNeeded());
        }
      }, PRUNE_INTERVAL_MS);

      // Periodic re-resolve
      if (helia) {
        resolveInterval = setInterval(resolveAll, RESOLVE_INTERVAL_MS);
        // Periodic IPNS republish (keeps records
        // alive when writers are offline)
        republishInterval = setInterval(
          republishAllIPNS,
          REPUBLISH_INTERVAL_MS,
        );
        // Initial republish after startup settles
        initialRepublishTimer = setTimeout(() => {
          track(republishAllIPNS());
        }, 5 * 60_000);
      }

      // Periodic history index persistence
      persistInterval = setInterval(() => {
        if (dirty && phase === "running") {
          dirty = false;
          persistHistoryIndex().catch((err) => {
            log.warn("periodic history persist failed:", err);
          });
        }
      }, PERSIST_INTERVAL_MS);

      // Periodic version thinning sweep
      thinSweepInterval = setInterval(() => {
        track(thinSweep());
      }, THIN_SWEEP_INTERVAL_MS);

      // Schedule queue processor
      if (config.pubsub) {
        scheduleInterval = setInterval(() => {
          track(processScheduleQueue());
        }, SCHEDULE_TICK_MS);
      }
    },

    async stop(): Promise<void> {
      if (phase === "stopped") return;
      phase = "stopped";
      shutdownCtrl.abort();
      if (resolveInterval) {
        clearInterval(resolveInterval);
      }
      if (republishInterval) {
        clearInterval(republishInterval);
      }
      if (initialRepublishTimer) {
        clearTimeout(initialRepublishTimer);
      }
      if (scheduleInterval) {
        clearInterval(scheduleInterval);
      }
      if (persistInterval) {
        clearInterval(persistInterval);
      }
      if (persistDebounceTimer) {
        clearTimeout(persistDebounceTimer);
      }
      if (thinSweepInterval) {
        clearInterval(thinSweepInterval);
      }
      if (pruneInterval) {
        clearInterval(pruneInterval);
      }
      await persistHistoryIndex();
      try {
        await store.close();
      } catch {
        // Already closed (double-stop) — fine
      }
    },

    onAnnouncement(
      ipnsName: string,
      cidStr: string,
      appId?: string,
      blockData?: Uint8Array,
      fromPinner?: boolean,
      proof?: string,
    ): void {
      if (phase !== "running") return;

      // Proof verification (#75): pinner re-announces
      // skip verification (already verified the original).
      // For others: reject if proof is present but invalid.
      // Accept unproven announcements during migration.
      if (!fromPinner && proof) {
        // Async verify — reject before fetch if invalid
        track(
          (async () => {
            const valid = await verifyAnnouncementProof(
              ipnsName,
              cidStr,
              proof,
            );
            if (!valid) {
              log.warn(
                `invalid proof for` +
                  ` ${ipnsName.slice(0, 12)}...` +
                  ` cid=${cidStr.slice(0, 12)}...`,
              );
              return;
            }
            // Proof valid — proceed with normal flow
            processAnnouncement(ipnsName, cidStr, appId, blockData, fromPinner);
          })(),
        );
        return;
      }

      if (!fromPinner && !proof) {
        log.debug(
          `no proof for` +
            ` ${ipnsName.slice(0, 12)}...` +
            ` (migration period)`,
        );
      }

      processAnnouncement(ipnsName, cidStr, appId, blockData, fromPinner);
    },

    onGuaranteeQuery(ipnsName: string, appId: string): void {
      if (phase !== "running") return;
      if (!knownNames.has(ipnsName)) return;
      if (!config.pubsub || !config.peerId) return;

      // Rate-limit: max 1 response per name per 3s
      const now = Date.now();
      const last = lastQueryResponse.get(ipnsName) ?? 0;
      if (now - last < QUERY_RESPONSE_COOLDOWN_MS) {
        return;
      }
      lastQueryResponse.set(ipnsName, now);

      const cidStr = history.getTip(ipnsName);
      if (!cidStr) return;

      const g = issueGuarantee(ipnsName);
      const response = {
        type: "guarantee-response",
        ipnsName,
        peerId: config.peerId,
        cid: cidStr,
        guaranteeUntil: g.guaranteeUntil,
        retainUntil: g.retainUntil,
      };
      const data = new TextEncoder().encode(JSON.stringify(response));
      const topic = announceTopic(appId);
      track(
        config.pubsub.publish(topic, data).catch((err) => {
          log.warn("guarantee response failed:", err);
        }),
      );
      log.debug(
        `guarantee response:` +
          ` ${ipnsName.slice(0, 12)}...` +
          ` cid=${cidStr.slice(0, 12)}...`,
      );

      // Bump re-announce priority: query is a demand
      // signal. Late-arriving browsers will catch the
      // next re-announce instead of waiting for decay.
      // Uses lazy deletion — duplicate heap entries
      // are harmless (stale ones skipped on pop).
      scheduleDoc(ipnsName, now + BASE_INTERVAL_MS);
    },

    async getTipData(ipnsName: string): Promise<TipData | null> {
      if (!knownNames.has(ipnsName)) return null;
      if (!config.peerId) return null;

      const cidStr = history.getTip(ipnsName);
      if (!cidStr) return null;

      // Read block from blockstore
      let block: Uint8Array;
      try {
        const cid = CID.parse(cidStr);
        if (helia) {
          const has = await helia.blockstore.has(cid);
          if (!has) return null;
          block = await helia.blockstore.get(cid);
        } else {
          const mem = memBlocks.get(cidStr);
          if (!mem) return null;
          block = mem;
        }
      } catch {
        return null;
      }

      // Get seq/ts from history
      const entry = history.getEntry(ipnsName);
      const tip = entry?.tip;

      const g = issueGuarantee(ipnsName);

      return {
        ipnsName,
        cid: cidStr,
        block,
        seq: entry ? entry.snapshots.length : 0,
        ts: tip?.ts ?? 0,
        peerId: config.peerId,
        guaranteeUntil: g.guaranteeUntil,
        retainUntil: g.retainUntil,
      };
    },

    getGuarantee(ipnsName: string): GuaranteeData | null {
      if (!knownNames.has(ipnsName)) return null;
      if (!config.peerId) return null;

      const cidStr = history.getTip(ipnsName);
      if (!cidStr) return null;

      const g = issueGuarantee(ipnsName);

      return {
        ipnsName,
        cid: cidStr,
        peerId: config.peerId,
        guaranteeUntil: g.guaranteeUntil,
        retainUntil: g.retainUntil,
      };
    },

    recordActivity(ipnsName: string): void {
      if (phase !== "running") return;
      if (!knownNames.has(ipnsName)) return;
      const now = Date.now();
      lastSeenAt.set(ipnsName, now);
      persistMutation(() => store.setLastSeen(ipnsName, now));
      // Reactivate if deactivated (#376)
      if (deactivatedNames.has(ipnsName)) {
        deactivatedNames.delete(ipnsName);
        persistMutation(() => store.clearDeactivated(ipnsName));
        log.info(`reactivated` + ` ${ipnsName.slice(0, 12)}...`);
      }
      // Bump re-announce priority
      scheduleDoc(ipnsName, now + BASE_INTERVAL_MS);
    },

    async ingest(ipnsName: string, block: Uint8Array): Promise<boolean> {
      if (phase !== "running") return false;

      // Admission gate: reject unknown names at capacity
      // or when new-name rate limit is exceeded.
      if (!knownNames.has(ipnsName)) {
        if (knownNames.size >= maxNames) {
          capacityRejects++;
          return false;
        }
        if (!newNameLimiter.tryAdmit()) {
          newNameRejects++;
          return false;
        }
      }

      // Rate limit: block size
      const check = rateLimiter.check(ipnsName, block.byteLength);
      if (!check.allowed) {
        rateLimitRejects++;
        return false;
      }

      // Structural validation
      const valid = await validateSnapshot(block);
      if (!valid) {
        return false;
      }

      // Compute CID for storage
      const hash = await sha256.digest(block);
      const cid = CID.create(1, dagCborCode, hash);

      // Decode to get timestamp
      const node = decodeSnapshot(block);

      // Verify publicKey↔ipnsName binding (#76)
      const expectedKey = hexToBytes(ipnsName);
      if (
        node.publicKey.length !== expectedKey.length ||
        !node.publicKey.every((b, i) => b === expectedKey[i])
      ) {
        log.warn(
          `ingest: publicKey mismatch for` + ` ${ipnsName.slice(0, 12)}...`,
        );
        return false;
      }

      // Store block
      await storeBlock(cid, block);
      const now = Date.now();
      knownNames.add(ipnsName);
      lastSeenAt.set(ipnsName, now);
      rateLimiter.record(ipnsName);
      history.add(ipnsName, cid, node.ts);
      snapshotsIngested++;

      // Write-through to LevelDB immediately — HTTP
      // ingest is rare and caller needs crash safety.
      await store.addName(ipnsName);
      await store.setTip(ipnsName, cid.toString());
      await store.setLastSeen(ipnsName, now);

      // Thin old versions after ingesting new one
      await thinVersionHistory(ipnsName);

      // Persist history index
      await persistHistoryIndex();

      return true;
    },
  };
}
