import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";
import { validateStructure, decodeSnapshot } from "@pokapali/snapshot";
import { hexToBytes } from "@pokapali/crypto";
import { ipns } from "@helia/ipns";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { resolveIPNS } from "@pokapali/core/ipns-helpers";
import {
  announceAck,
  announceSnapshot,
  announceTopic,
} from "@pokapali/core/announce";
import type { AnnouncePubSub, AnnouncementAck } from "@pokapali/core/announce";
import { createRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";
import { createHistoryTracker } from "./history.js";
import type { HistoryTracker } from "./history.js";
import { loadState, saveState } from "./state.js";
import { createLogger } from "@pokapali/log";
import type { Helia } from "helia";

const log = createLogger("pinner");

const RESOLVE_INTERVAL_MS = 5 * 60_000;
const REPUBLISH_INTERVAL_MS = 4 * 60 * 60_000;
const REPUBLISH_BATCH_SIZE = 5;
const REPUBLISH_TIMEOUT_MS = 15_000;
const PERSIST_INTERVAL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 5_000;

// Two-phase guarantee model:
// Phase 1: active re-announcing (7 days from last activity)
const GUARANTEE_DURATION_MS = 7 * 24 * 60 * 60_000;
// Phase 2: block retention (14 days from last activity)
const RETENTION_DURATION_MS = 14 * 24 * 60 * 60_000;

// Continuous scheduling constants
const BASE_INTERVAL_MS = 30_000;
const HALF_LIFE_MS = 12 * 60 * 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const SCHEDULE_TICK_MS = 5_000;

// Self-tuning capacity
const INITIAL_PER_DOC_MS = 50;
const EMA_ALPHA = 0.3;
// Prune metadata when tracking > capacity * 10
const PRUNE_HEADROOM = 10;

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
}

export interface PinnerMetrics {
  knownNames: number;
  tipsTracked: number;
  acksTracked: number;
  snapshotsIngested: number;
  rateLimitRejects: number;
  reannounceCount: number;
  lastReannounceMs: number;
  lastPersistMs: number;
  stateWriteCount: number;
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
  ): void;
  onGuaranteeQuery(ipnsName: string, appId: string): void;
  metrics(): PinnerMetrics;
  history: HistoryTracker;
}

export async function createPinner(config: PinnerConfig): Promise<Pinner> {
  const rateLimits: RateLimiterConfig = {
    maxSnapshotsPerHour:
      config.rateLimits?.maxPerHour ?? DEFAULT_RATE_LIMITS.maxSnapshotsPerHour,
    maxBlockSizeBytes:
      config.rateLimits?.maxSizeBytes ?? DEFAULT_RATE_LIMITS.maxBlockSizeBytes,
  };
  const rateLimiter = createRateLimiter(rateLimits);
  const history = createHistoryTracker();
  const statePath = config.storagePath + "/state.json";
  const helia = config.helia;

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
  // max 1 response per ipnsName per 10s.
  const lastQueryResponse = new Map<string, number>();
  const QUERY_RESPONSE_COOLDOWN_MS = 10_000;

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
      if (heap[parent].nextAt <= heap[i].nextAt) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
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
        if (l < heap.length && heap[l].nextAt < heap[smallest].nextAt)
          smallest = l;
        if (r < heap.length && heap[r].nextAt < heap[smallest].nextAt)
          smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
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
    // Remove existing entry by marking stale
    // (lazy deletion — checked on pop)
    heapPush({ ipnsName, nextAt });
    inHeap.add(ipnsName);
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

    // Past guarantee window — don't re-announce
    if (age >= GUARANTEE_DURATION_MS) {
      return MAX_INTERVAL_MS;
    }

    const recencyFactor = Math.pow(2, age / HALF_LIFE_MS);
    const interval = BASE_INTERVAL_MS * recencyFactor * loadFactor();
    return Math.min(interval, MAX_INTERVAL_MS);
  }

  function maxActiveDocs(): number {
    return Math.max(1, Math.floor((BASE_INTERVAL_MS * 0.8) / perDocEma));
  }

  function issueGuarantee(ipnsName: string): {
    guaranteeUntil: number;
    retainUntil: number;
  } {
    const seen = lastSeenAt.get(ipnsName) ?? Date.now();
    const calculated = seen + GUARANTEE_DURATION_MS;
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
  let stopped = false;
  let resolveInterval: ReturnType<typeof setInterval> | null = null;
  let republishInterval: ReturnType<typeof setInterval> | null = null;
  let initialRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduleInterval: ReturnType<typeof setInterval> | null = null;
  let persistInterval: ReturnType<typeof setInterval> | null = null;
  let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  // Counters for /metrics endpoint
  let snapshotsIngested = 0;
  let rateLimitRejects = 0;
  let reannounceCount = 0;
  let lastReannounceMs = 0;
  let lastPersistMs = 0;
  let stateWriteCount = 0;

  function markDirty(): void {
    dirty = true;
    // Debounce: persist within 5s of last change
    if (persistDebounceTimer) {
      clearTimeout(persistDebounceTimer);
    }
    persistDebounceTimer = setTimeout(() => {
      persistDebounceTimer = null;
      if (dirty && !stopped) {
        dirty = false;
        persistState().catch((err) => {
          log.warn("debounced persist failed:", err);
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
        // Store inline block for future use
        await helia.blockstore.put(cid, blockData);
      } else {
        block = await helia.blockstore.get(cid, {
          signal: AbortSignal.timeout(30_000),
        });
      }

      const valid = await validateStructure(block);
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
      knownNames.add(ipnsName);
      history.add(ipnsName, cid, node.ts);
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
      const keyBytes = hexToBytes(ipnsName);
      const cid = await resolveIPNS(helia, keyBytes);
      if (!cid) {
        log.error(`resolve returned null for` + ` ${ipnsName.slice(0, 12)}...`);
        return false;
      }
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
      (n) => reannounceInterval(n, now) < MAX_INTERVAL_MS,
    );
    if (names.length === 0) return;
    log.debug(
      `re-resolving ${names.length}/${knownNames.size}` + ` scheduled names`,
    );
    // Batch to avoid OOM from unbounded concurrency
    const BATCH_SIZE = 10;
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      if (stopped) break;
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
  /**
   * Republish a single IPNS record. Extracted so it
   * can be called in parallel batches.
   */
  async function republishOne(ipnsName: string): Promise<boolean> {
    if (!helia) return false;
    try {
      const name = ipns(helia as any);
      const keyBytes = hexToBytes(ipnsName);
      const pubKey = publicKeyFromRaw(keyBytes);

      const result = await name.resolve(pubKey, {
        signal: AbortSignal.timeout(REPUBLISH_TIMEOUT_MS),
      });

      await name.republishRecord(pubKey.toMultihash(), result.record, {
        signal: AbortSignal.timeout(REPUBLISH_TIMEOUT_MS),
      });
      log.debug(`republished IPNS for` + ` ${ipnsName.slice(0, 12)}...`);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log.error(
        `IPNS republish failed for` +
          ` ${ipnsName.slice(0, 12)}...:` +
          ` ${msg}`,
      );
      return false;
    }
  }

  async function republishAllIPNS(): Promise<void> {
    if (!helia) return;

    const now = Date.now();
    // Only republish docs still within retention
    const names = [...knownNames].filter((n) => {
      const seen = lastSeenAt.get(n) ?? 0;
      return seen + RETENTION_DURATION_MS > now;
    });
    if (names.length === 0) return;

    const start = Date.now();
    log.info(
      `republishing IPNS for` +
        ` ${names.length}/${knownNames.size}` +
        ` retained names` +
        ` (batch=${REPUBLISH_BATCH_SIZE})`,
    );

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < names.length; i += REPUBLISH_BATCH_SIZE) {
      if (stopped) break;
      const batch = names.slice(i, i + REPUBLISH_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((n) => republishOne(n)),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          ok++;
        } else {
          fail++;
        }
      }
    }

    const elapsed = Date.now() - start;
    log.info(
      `IPNS republish done:` +
        ` ${ok} ok, ${fail} failed` +
        ` in ${elapsed}ms` +
        ` (${
          names.length > 0 ? (elapsed / names.length).toFixed(0) : 0
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

    while (heap.length > 0 && !stopped) {
      const top = heapPeek()!;
      if (top.nextAt > start) break;

      heapPop();

      // Skip if doc was removed or is stale
      if (!knownNames.has(top.ipnsName)) {
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
  }

  /**
   * Prune docs past retention (14 days of inactivity).
   * Capacity backstop: if tracking > capacity * 10,
   * prune oldest by lastSeenAt even if < 14 days.
   */
  async function pruneIfNeeded(): Promise<void> {
    const now = Date.now();
    const toPrune: string[] = [];

    // Primary: time-based retention pruning
    for (const name of knownNames) {
      const seen = lastSeenAt.get(name) ?? 0;
      if (seen + RETENTION_DURATION_MS < now) {
        toPrune.push(name);
      }
    }

    // Capacity backstop: if still over limit after
    // time-based pruning, prune oldest
    const remaining = knownNames.size - toPrune.length;
    const maxTracked = maxActiveDocs() * PRUNE_HEADROOM;
    if (remaining > maxTracked) {
      const pruneSet = new Set(toPrune);
      const sorted = [...knownNames]
        .filter((n) => !pruneSet.has(n))
        .map((n) => ({
          name: n,
          seen: lastSeenAt.get(n) ?? 0,
        }))
        .sort((a, b) => a.seen - b.seen);
      const extra = sorted.slice(0, remaining - maxTracked);
      for (const { name } of extra) {
        toPrune.push(name);
      }
    }

    for (const name of toPrune) {
      // Delete block from blockstore
      const tipCid = history.getTip(name);
      if (tipCid && helia) {
        try {
          const cid = CID.parse(tipCid);
          await helia.blockstore.delete(cid);
        } catch (err) {
          log.warn(
            "blockstore delete failed for" + ` ${name.slice(0, 12)}...:`,
            (err as Error).message,
          );
        }
      }

      knownNames.delete(name);
      lastSeenAt.delete(name);
      lastAckedCid.delete(name);
      nameToAppId.delete(name);
      guaranteedUntil.delete(name);
      inHeap.delete(name);
    }

    if (toPrune.length > 0) {
      markDirty();
      log.info(
        `pruned ${toPrune.length} docs,` + ` ${knownNames.size} remaining`,
      );
    }
  }

  async function restoreState(): Promise<void> {
    const state = await loadState(statePath);
    for (const n of state.knownNames) {
      knownNames.add(n);
    }
    if (state.tips) {
      for (const [name, cidStr] of Object.entries(state.tips)) {
        history.add(name, CID.parse(cidStr), Date.now());
      }
    }
    if (state.nameToAppId) {
      for (const [name, appId] of Object.entries(state.nameToAppId)) {
        nameToAppId.set(name, appId);
      }
    }
    if (state.lastSeenAt) {
      for (const [name, ts] of Object.entries(state.lastSeenAt)) {
        lastSeenAt.set(name, ts);
      }
    }
    // Backfill lastSeenAt for names from old state
    // files that don't have it — use 0 so they get
    // pruned on next cycle.
    for (const name of knownNames) {
      if (!lastSeenAt.has(name)) {
        lastSeenAt.set(name, 0);
      }
    }
    // Seed the schedule queue from restored state
    const now = Date.now();
    for (const name of knownNames) {
      const interval = reannounceInterval(name, now);
      if (interval < MAX_INTERVAL_MS) {
        scheduleDoc(name, now + interval);
      }
    }
  }

  async function persistState(): Promise<void> {
    const start = Date.now();
    const tips: Record<string, string> = {};
    for (const name of knownNames) {
      const tip = history.getTip(name);
      if (tip) tips[name] = tip;
    }
    await saveState(statePath, {
      knownNames: [...knownNames],
      tips,
      nameToAppId: Object.fromEntries(nameToAppId),
      lastSeenAt: Object.fromEntries(lastSeenAt),
    });
    lastPersistMs = Date.now() - start;
    stateWriteCount++;
  }

  return {
    history,

    metrics(): PinnerMetrics {
      return {
        knownNames: knownNames.size,
        tipsTracked: history.allNames().length,
        acksTracked: lastAckedCid.size,
        snapshotsIngested,
        rateLimitRejects,
        reannounceCount,
        lastReannounceMs,
        lastPersistMs,
        stateWriteCount,
      };
    },

    async flush(): Promise<void> {
      await Promise.allSettled([...pending]);
    },

    async start(): Promise<void> {
      await restoreState();
      await pruneIfNeeded();

      // Resolve all persisted names on startup
      if (helia && knownNames.size > 0) {
        log.info(`startup: resolving` + ` ${knownNames.size} persisted names`);
        // Fire and forget — don't block startup
        track(resolveAll());
      }

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

      // Periodic state persistence as safety net
      persistInterval = setInterval(() => {
        if (dirty && !stopped) {
          dirty = false;
          persistState().catch((err) => {
            log.warn("periodic persist failed:", err);
          });
        }
      }, PERSIST_INTERVAL_MS);

      // Schedule queue processor
      if (config.pubsub) {
        scheduleInterval = setInterval(() => {
          track(processScheduleQueue());
        }, SCHEDULE_TICK_MS);
      }
    },

    async stop(): Promise<void> {
      stopped = true;
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
      await persistState();
    },

    onAnnouncement(
      ipnsName: string,
      cidStr: string,
      appId?: string,
      blockData?: Uint8Array,
      fromPinner?: boolean,
    ): void {
      knownNames.add(ipnsName);
      if (appId) nameToAppId.set(ipnsName, appId);

      // Only refresh lastSeenAt for non-pinner
      // announcements (writer/reader activity).
      // Pinner re-announces are supply signals and
      // must NOT keep docs alive indefinitely.
      if (!fromPinner) {
        lastSeenAt.set(ipnsName, Date.now());
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
    },

    onGuaranteeQuery(ipnsName: string, appId: string): void {
      if (!knownNames.has(ipnsName)) return;
      if (!config.pubsub || !config.peerId) return;

      // Rate-limit: max 1 response per name per 10s
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
    },

    async ingest(ipnsName: string, block: Uint8Array): Promise<boolean> {
      // Rate limit: block size
      const check = rateLimiter.check(ipnsName, block.byteLength);
      if (!check.allowed) {
        rateLimitRejects++;
        return false;
      }

      // Structural validation
      const valid = await validateStructure(block);
      if (!valid) {
        return false;
      }

      // Compute CID for storage
      const hash = await sha256.digest(block);
      const cid = CID.create(1, dagCborCode, hash);

      // Decode to get timestamp
      const node = decodeSnapshot(block);

      // Store block
      await storeBlock(cid, block);
      knownNames.add(ipnsName);
      lastSeenAt.set(ipnsName, Date.now());
      rateLimiter.record(ipnsName);
      history.add(ipnsName, cid, node.ts);
      markDirty();
      snapshotsIngested++;

      return true;
    },
  };
}
