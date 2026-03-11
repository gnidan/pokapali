import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import {
  announceTopic,
  parseAnnouncement,
  parseGuaranteeResponse,
  publishGuaranteeQuery,
  announceSnapshot,
  base64ToUint8,
  MAX_INLINE_BLOCK_BYTES,
} from "./announce.js";
import { uploadBlock } from "./block-upload.js";
import { resolveIPNS, watchIPNS } from "./ipns-helpers.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("snapshot-watcher");
import type { Helia } from "helia";

const REANNOUNCE_MS = 15_000;
const RETRY_INTERVAL_MS = 30_000;
const MAX_OUTER_RETRIES = 10;
const GUARANTEE_REQUERY_MS = 5 * 60_000;
/** Delay before initial guarantee query to let
 *  the GossipSub mesh form after subscribe. */
const GUARANTEE_INITIAL_DELAY_MS = 3_000;

export type LoadingState =
  | { status: "idle" }
  | { status: "resolving"; startedAt: number }
  | { status: "fetching"; cid: string; startedAt: number }
  | { status: "retrying"; cid: string; attempt: number; nextRetryAt: number }
  | { status: "failed"; cid: string; error: string };

export type GossipActivity = "inactive" | "subscribed" | "receiving";

const GOSSIP_RECENCY_MS = 60_000;
const GOSSIP_DECAY_MS = 30_000;

export interface SnapshotWatcherOptions {
  appId: string;
  ipnsName: string;
  pubsub: PubSubLike;
  getHelia: () => Helia;
  isWriter: boolean;
  ipnsPublicKeyBytes?: Uint8Array;
  onSnapshot: (cid: CID) => Promise<void>;
  performInitialResolve?: boolean;
  /** Dynamic getter for relay HTTP URLs (for large
   *  block uploads during re-announce). */
  httpUrls?: () => string[];
}

export interface SnapshotWatcherEvents {
  "fetch-state": [LoadingState];
  ack: [string];
  "gossip-activity": [GossipActivity];
  "guarantee-query": [];
}

export interface SnapshotWatcher {
  startReannounce(
    getCid: () => CID | null,
    getBlock: (cidStr: string) => Uint8Array | undefined,
    getSeq?: () => number | null,
  ): void;
  /** Trigger an immediate re-announce (e.g. on new
   *  relay connect). No-op if startReannounce hasn't
   *  been called or no snapshot exists yet. */
  reannounceNow(): void;
  /** Fire a guarantee query immediately (e.g. on
   *  pinner discovery via node caps). */
  queryGuarantees(): void;
  /** Track a newly pushed CID for ack collection. */
  trackCidForAcks(cid: string): void;
  readonly latestAnnouncedSeq: number;
  readonly fetchState: LoadingState;
  readonly hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  readonly ackedBy: ReadonlySet<string>;
  /** Latest guarantee-until timestamp across all
   *  pinners for the current CID, or null if none. */
  readonly guaranteeUntil: number | null;
  /** Latest retain-until timestamp across all
   *  pinners for the current CID, or null if none. */
  readonly retainUntil: number | null;
  /** GossipSub liveness: inactive → subscribed →
   *  receiving. Decays after 60s without messages. */
  readonly gossipActivity: GossipActivity;
  on<E extends keyof SnapshotWatcherEvents>(
    event: E,
    cb: (...args: SnapshotWatcherEvents[E]) => void,
  ): void;
  off<E extends keyof SnapshotWatcherEvents>(
    event: E,
    cb: (...args: SnapshotWatcherEvents[E]) => void,
  ): void;
  destroy(): void;
}

export function createSnapshotWatcher(
  options: SnapshotWatcherOptions,
): SnapshotWatcher {
  const {
    appId,
    ipnsName,
    pubsub,
    getHelia,
    isWriter,
    ipnsPublicKeyBytes,
    onSnapshot,
  } = options;

  // --- Typed event emitter ---
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  function emit<E extends keyof SnapshotWatcherEvents>(
    event: E,
    ...args: SnapshotWatcherEvents[E]
  ) {
    const cbs = listeners.get(event as string);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let destroyed = false;
  const topic = announceTopic(appId);
  let latestAnnouncedSeq = 0;
  let retryAttempt = 0;
  let fetchState: LoadingState = { status: "idle" };
  let hasAppliedSnapshot = false;
  /** Tracks which CID the acks are for. */
  let ackedCid: string | null = null;
  /** Dedup: skip re-announce if we already
   *  announced this CID (prevents amplification
   *  loop between readers). */
  let lastAnnouncedCid: string | null = null;
  const ackedBy = new Set<string>();
  const pinnerGuarantees = new Map<
    string,
    { guarantee: number; retain: number }
  >();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // --- GossipSub liveness tracking ---
  let lastGossipMessageAt = 0;
  let gossipSubscribed = false;
  let gossipDecayTimer: ReturnType<typeof setInterval> | null = null;
  let lastReportedGossipActivity: GossipActivity = "inactive";

  function currentGossipActivity(): GossipActivity {
    if (
      lastGossipMessageAt > 0 &&
      Date.now() - lastGossipMessageAt < GOSSIP_RECENCY_MS
    ) {
      return "receiving";
    }
    if (gossipSubscribed) return "subscribed";
    return "inactive";
  }

  function checkGossipActivity() {
    const next = currentGossipActivity();
    if (next !== lastReportedGossipActivity) {
      lastReportedGossipActivity = next;
      emit("gossip-activity", next);
    }
  }

  function touchGossip() {
    lastGossipMessageAt = Date.now();
    checkGossipActivity();
  }

  function markGossipSubscribed() {
    gossipSubscribed = true;
    checkGossipActivity();
  }

  // Decay timer: check every 30s whether
  // "receiving" has expired.
  gossipDecayTimer = setInterval(checkGossipActivity, GOSSIP_DECAY_MS);

  function setFetchState(s: LoadingState) {
    fetchState = s;
    emit("fetch-state", s);
  }

  /** Extract CID from current fetch state, or null
   *  when idle/resolving (no active CID). */
  function fetchCid(): string | null {
    if (
      fetchState.status === "fetching" ||
      fetchState.status === "retrying" ||
      fetchState.status === "failed"
    ) {
      return fetchState.cid;
    }
    return null;
  }

  // --- Announce subscription ---

  // Writers already subscribe for re-announce mesh
  // in startReannounce; readers subscribe here.
  if (!isWriter) {
    log.debug("subscribing to announce topic:", topic);
    pubsub.subscribe(topic);
    markGossipSubscribed();
  }

  // Fire initial guarantee query after subscribing
  // so pinners respond with their current state.
  function fireGuaranteeQuery() {
    log.info("firing guarantee query");
    emit("guarantee-query");
    publishGuaranteeQuery(pubsub, appId, ipnsName)
      .then(() => {
        log.debug("guarantee query published");
      })
      .catch((err) => {
        log.warn("guarantee query failed:", err);
      });
  }

  // Delay initial query so GossipSub mesh can form
  // after subscribe (GRAFT requires a heartbeat).
  // Readers delay here; writers delay in
  // startReannounce.
  let initialQueryTimer: ReturnType<typeof setTimeout> | null = null;
  if (!isWriter) {
    initialQueryTimer = setTimeout(() => {
      initialQueryTimer = null;
      if (!destroyed) fireGuaranteeQuery();
    }, GUARANTEE_INITIAL_DELAY_MS);
  }

  // Re-query periodically for long sessions
  const guaranteeQueryTimer = setInterval(() => {
    if (!destroyed) fireGuaranteeQuery();
  }, GUARANTEE_REQUERY_MS);

  function scheduleRetry() {
    if (retryTimer) return;
    const cid = fetchCid();
    if (!cid) return;
    retryAttempt++;
    if (retryAttempt > MAX_OUTER_RETRIES) {
      log.warn("max retries exceeded for", cid.slice(0, 16) + "...");
      setFetchState({
        status: "failed",
        cid,
        error: "max retries exceeded",
      });
      return;
    }
    const nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
    setFetchState({
      status: "retrying",
      cid,
      attempt: retryAttempt,
      nextRetryAt,
    });
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (destroyed) return;
      const retryCid = fetchCid();
      if (!retryCid) return;
      log.debug("retrying fetch for", retryCid.slice(0, 16) + "...");
      setFetchState({
        status: "fetching",
        cid: retryCid,
        startedAt: Date.now(),
      });
      try {
        await onSnapshot(CIDClass.parse(retryCid));
        if (destroyed) return;
        hasAppliedSnapshot = true;
        retryAttempt = 0;
        setFetchState({ status: "idle" });
      } catch (err) {
        log.warn(
          "snapshot fetch/apply failed:",
          (err as Error)?.message ?? err,
        );
        if (!destroyed) scheduleRetry();
      }
    }, RETRY_INTERVAL_MS);
  }

  const announceHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;

    // Check for guarantee response first
    const gResp = parseGuaranteeResponse(detail.data);
    if (gResp && gResp.ipnsName === ipnsName) {
      if (destroyed) return;
      log.info(
        "guarantee response received from",
        gResp.peerId.slice(-8),
        "guarantee:",
        gResp.guaranteeUntil,
        "retain:",
        gResp.retainUntil,
      );
      touchGossip();
      // Update guarantees for the responding pinner
      // (same monotonic logic as ack handling).
      const prev = pinnerGuarantees.get(gResp.peerId) ?? {
        guarantee: 0,
        retain: 0,
      };
      const updated = {
        guarantee: Math.max(prev.guarantee, gResp.guaranteeUntil ?? 0),
        retain: Math.max(prev.retain, gResp.retainUntil ?? 0),
      };
      const changed =
        updated.guarantee !== prev.guarantee || updated.retain !== prev.retain;
      pinnerGuarantees.set(gResp.peerId, updated);
      // Track as acked if CID matches
      if (gResp.cid === ackedCid) {
        const isNew = !ackedBy.has(gResp.peerId);
        ackedBy.add(gResp.peerId);
        if (isNew) {
          log.debug("guarantee-response from", gResp.peerId.slice(-8));
        }
      }
      // Notify on any guarantee change so the UI
      // can update even without a CID match.
      if (changed) {
        emit("ack", gResp.peerId);
      }
      return;
    }

    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;
    if (destroyed) return;

    touchGossip();

    // Handle pinner ack (may coexist with snapshot
    // data in pinner re-announces).
    if (ann.ack) {
      if (ann.cid === ackedCid) {
        const isNew = !ackedBy.has(ann.ack.peerId);
        ackedBy.add(ann.ack.peerId);
        if (
          ann.ack.guaranteeUntil !== undefined ||
          ann.ack.retainUntil !== undefined
        ) {
          const prev = pinnerGuarantees.get(ann.ack.peerId) ?? {
            guarantee: 0,
            retain: 0,
          };
          pinnerGuarantees.set(ann.ack.peerId, {
            guarantee: Math.max(prev.guarantee, ann.ack.guaranteeUntil ?? 0),
            retain: Math.max(prev.retain, ann.ack.retainUntil ?? 0),
          });
        }
        if (isNew) {
          log.debug(
            "ack from",
            ann.ack.peerId.slice(-8),
            "for",
            ann.cid.slice(0, 16) + "...",
          );
          emit("ack", ann.ack.peerId);
        }
      } else {
        log.debug(
          "ack cid mismatch:",
          ann.cid?.slice(0, 16),
          "expected:",
          ackedCid?.slice(0, 16),
        );
      }
      // Ack-only message: no snapshot data to process.
      // Pinner re-announces carry fromPinner + ack but
      // no seq/block — those still need onSnapshot.
      if (!ann.fromPinner && !ann.block && ann.seq === undefined) return;
    }

    log.debug("announce received:", ann.cid.slice(0, 16) + "...");
    if (ann.seq !== undefined) {
      latestAnnouncedSeq = Math.max(latestAnnouncedSeq, ann.seq);
    }
    // Clear any pending retry for a previous CID.
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryAttempt = 0;
    setFetchState({
      status: "fetching",
      cid: ann.cid,
      startedAt: Date.now(),
    });
    const cid = CIDClass.parse(ann.cid);

    // If announcement includes block data, put it
    // in the blockstore so fetchBlock finds it.
    if (ann.block) {
      try {
        const blockBytes = base64ToUint8(ann.block);
        const helia = getHelia();
        Promise.resolve(helia.blockstore.put(cid, blockBytes)).catch((err) => {
          log.warn("blockstore.put from announce failed:", err);
        });
      } catch (err) {
        log.warn("block decode failed:", err);
      }
    }

    onSnapshot(cid)
      .then(() => {
        if (destroyed) return;
        hasAppliedSnapshot = true;
        setFetchState({ status: "idle" });
        if (ann.cid !== lastAnnouncedCid) {
          lastAnnouncedCid = ann.cid;
          announceSnapshot(pubsub, appId, ipnsName, ann.cid, ann.seq);
        }
      })
      .catch((err) => {
        if (destroyed) return;
        log.warn("announce apply failed:", err);
        scheduleRetry();
      });
  };

  pubsub.addEventListener("message", announceHandler);

  // --- IPNS polling fallback ---

  let stopWatch: (() => void) | null = null;
  if (ipnsPublicKeyBytes) {
    stopWatch = watchIPNS(
      getHelia(),
      ipnsPublicKeyBytes,
      async (cid) => {
        if (destroyed) return;
        const cidStr = cid.toString();
        // Clear any pending retry for a previous CID.
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        retryAttempt = 0;
        setFetchState({
          status: "fetching",
          cid: cidStr,
          startedAt: Date.now(),
        });
        try {
          await onSnapshot(cid);
          if (destroyed) return;
          hasAppliedSnapshot = true;
          setFetchState({ status: "idle" });
          if (cidStr !== lastAnnouncedCid) {
            lastAnnouncedCid = cidStr;
            announceSnapshot(
              pubsub,
              appId,
              ipnsName,
              cidStr,
              latestAnnouncedSeq || undefined,
            );
          }
        } catch (err) {
          log.warn(
            "IPNS snapshot apply failed:",
            (err as Error)?.message ?? err,
          );
          if (!destroyed) scheduleRetry();
        }
      },
      {
        onPollStart: () => {
          if (
            fetchState.status !== "fetching" &&
            fetchState.status !== "resolving"
          ) {
            setFetchState({
              status: "resolving",
              startedAt: Date.now(),
            });
          }
        },
      },
    );
  }

  // --- Initial IPNS resolve ---

  if (options.performInitialResolve && ipnsPublicKeyBytes) {
    const pubKeyBytes = ipnsPublicKeyBytes;
    setFetchState({
      status: "resolving",
      startedAt: Date.now(),
    });
    (async () => {
      try {
        const helia = getHelia();
        const tipCid = await resolveIPNS(helia, pubKeyBytes);
        if (tipCid && !destroyed) {
          log.info("IPNS resolved:", tipCid.toString());
          const cidStr = tipCid.toString();
          retryAttempt = 0;
          setFetchState({
            status: "fetching",
            cid: cidStr,
            startedAt: Date.now(),
          });
          await onSnapshot(tipCid);
          if (destroyed) return;
          hasAppliedSnapshot = true;
          setFetchState({ status: "idle" });
          if (cidStr !== lastAnnouncedCid) {
            lastAnnouncedCid = cidStr;
            announceSnapshot(
              pubsub,
              appId,
              ipnsName,
              cidStr,
              latestAnnouncedSeq || undefined,
            );
          }
          log.info("initial snapshot applied");
        } else if (isWriter) {
          // Writer on a new doc — nothing published yet.
          // Go idle so the editor mounts immediately.
          log.debug("IPNS resolve null (writer, new doc)");
          setFetchState({ status: "idle" });
        } else {
          log.debug("IPNS resolve returned null");
          retryAttempt++;
          setFetchState({
            status: "retrying",
            cid: "",
            attempt: retryAttempt,
            nextRetryAt: Date.now() + RETRY_INTERVAL_MS,
          });
        }
      } catch (err) {
        log.warn("initial snapshot load failed:", err);
        scheduleRetry();
      }
    })();
  }

  // --- Re-announce timer (writers only) ---

  let announceTimer: ReturnType<typeof setInterval> | null = null;

  let reannounceGetCid: (() => CID | null) | null = null;
  let reannounceGetBlock: ((s: string) => Uint8Array | undefined) | null = null;
  let reannounceGetSeq: (() => number | null) | null = null;

  function doReannounce() {
    if (!reannounceGetCid) return;
    const cid = reannounceGetCid();
    if (!cid) return;
    const cidStr = cid.toString();
    const block = reannounceGetBlock?.(cidStr);
    if (block) {
      const helia = getHelia();
      Promise.resolve(helia.blockstore.put(cid, block)).catch((err) => {
        log.warn("blockstore.put failed:", err);
      });
    }
    const seq = reannounceGetSeq?.() ?? undefined;
    log.debug("re-announce:", cidStr.slice(0, 16));

    // Large blocks: upload via HTTP before announcing
    // without inline data. Best-effort — announce
    // still goes out even if upload fails.
    if (block && block.length > MAX_INLINE_BLOCK_BYTES) {
      const urls = options.httpUrls?.() ?? [];
      if (urls.length > 0) {
        uploadBlock(cid, block, urls).catch((err) => {
          log.warn("re-announce upload failed:", err);
        });
      }
    }

    try {
      announceSnapshot(pubsub, appId, ipnsName, cidStr, seq, block);
    } catch (err) {
      log.warn("re-announce failed:", err);
    }
  }

  return {
    startReannounce(getCid, getBlock, getSeq) {
      if (announceTimer) return;
      // Subscribe so writer joins the GossipSub
      // mesh for the announce topic.
      pubsub.subscribe(topic);
      markGossipSubscribed();
      // Delay so GossipSub mesh can form after
      // subscribe before publishing the query.
      initialQueryTimer = setTimeout(() => {
        initialQueryTimer = null;
        if (!destroyed) fireGuaranteeQuery();
      }, GUARANTEE_INITIAL_DELAY_MS);

      reannounceGetCid = getCid;
      reannounceGetBlock = getBlock;
      reannounceGetSeq = getSeq ?? null;

      announceTimer = setInterval(doReannounce, REANNOUNCE_MS);
    },

    reannounceNow() {
      doReannounce();
    },

    queryGuarantees() {
      fireGuaranteeQuery();
    },

    trackCidForAcks(cid: string) {
      if (cid !== ackedCid) {
        ackedCid = cid;
        ackedBy.clear();
        pinnerGuarantees.clear();
      }
    },

    get latestAnnouncedSeq() {
      return latestAnnouncedSeq;
    },

    get fetchState() {
      return fetchState;
    },

    get hasAppliedSnapshot() {
      return hasAppliedSnapshot;
    },

    get ackedBy(): ReadonlySet<string> {
      return ackedBy;
    },

    get guaranteeUntil(): number | null {
      if (pinnerGuarantees.size === 0) return null;
      let max = 0;
      for (const v of pinnerGuarantees.values()) {
        if (v.guarantee > max) max = v.guarantee;
      }
      return max || null;
    },

    get retainUntil(): number | null {
      if (pinnerGuarantees.size === 0) return null;
      let max = 0;
      for (const v of pinnerGuarantees.values()) {
        if (v.retain > max) max = v.retain;
      }
      return max || null;
    },

    get gossipActivity(): GossipActivity {
      return currentGossipActivity();
    },

    /* eslint-disable @typescript-eslint/no-explicit-any */
    on(event: string, cb: (...a: any[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(event: string, cb: (...a: any[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    /* eslint-enable @typescript-eslint/no-explicit-any */

    destroy() {
      listeners.clear();
      destroyed = true;
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = null;
      }
      clearInterval(guaranteeQueryTimer);
      if (initialQueryTimer) {
        clearTimeout(initialQueryTimer);
        initialQueryTimer = null;
      }
      if (gossipDecayTimer) {
        clearInterval(gossipDecayTimer);
        gossipDecayTimer = null;
      }
      if (stopWatch) {
        stopWatch();
        stopWatch = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      pubsub.removeEventListener("message", announceHandler);
    },
  };
}
