import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import {
  announceTopic,
  parseAnnouncement,
  announceSnapshot,
  base64ToUint8,
} from "./announce.js";
import { resolveIPNS, watchIPNS } from
  "./ipns-helpers.js";
import type { BlockGetter } from "./fetch-block.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("snapshot-watcher");
import type { Helia } from "helia";

const REANNOUNCE_MS = 15_000;
const RETRY_INTERVAL_MS = 30_000;
const MAX_OUTER_RETRIES = 10;

export type SnapshotFetchState =
  | { status: "idle" }
  | { status: "resolving"; startedAt: number }
  | { status: "fetching"; cid: string;
      startedAt: number }
  | { status: "retrying"; cid: string;
      attempt: number; nextRetryAt: number }
  | { status: "failed"; cid: string;
      error: string };

export type GossipActivity =
  | "inactive"
  | "subscribed"
  | "receiving";

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
  onFetchStateChange?: (
    state: SnapshotFetchState,
  ) => void;
  onAck?: (peerId: string) => void;
  onGossipActivityChange?: (
    activity: GossipActivity,
  ) => void;
  performInitialResolve?: boolean;
}

export interface SnapshotWatcher {
  startReannounce(
    getCid: () => CID | null,
    getBlock: (
      cidStr: string,
    ) => Uint8Array | undefined,
    getSeq?: () => number | null,
  ): void;
  /** Trigger an immediate re-announce (e.g. on new
   *  relay connect). No-op if startReannounce hasn't
   *  been called or no snapshot exists yet. */
  reannounceNow(): void;
  /** Track a newly pushed CID for ack collection. */
  trackCidForAcks(cid: string): void;
  readonly latestAnnouncedSeq: number;
  readonly fetchState: SnapshotFetchState;
  readonly hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  readonly ackedBy: ReadonlySet<string>;
  /** Latest guarantee-until timestamp across all
   *  pinners for the current CID, or null if none. */
  readonly guaranteeUntil: number | null;
  /** GossipSub liveness: inactive → subscribed →
   *  receiving. Decays after 60s without messages. */
  readonly gossipActivity: GossipActivity;
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

  let destroyed = false;
  const topic = announceTopic(appId);
  let pendingCid: string | null = null;
  let latestAnnouncedSeq = 0;
  let retryAttempt = 0;
  let fetchState: SnapshotFetchState =
    { status: "idle" };
  let hasAppliedSnapshot = false;
  /** Tracks which CID the acks are for. */
  let ackedCid: string | null = null;
  /** Dedup: skip re-announce if we already
   *  announced this CID (prevents amplification
   *  loop between readers). */
  let lastAnnouncedCid: string | null = null;
  const ackedBy = new Set<string>();
  const pinnerGuarantees = new Map<string, number>();
  let retryTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  // --- GossipSub liveness tracking ---
  let lastGossipMessageAt = 0;
  let gossipSubscribed = false;
  let gossipDecayTimer: ReturnType<
    typeof setInterval
  > | null = null;
  let lastReportedGossipActivity:
    GossipActivity = "inactive";

  function currentGossipActivity(): GossipActivity {
    if (
      lastGossipMessageAt > 0 &&
      Date.now() - lastGossipMessageAt
        < GOSSIP_RECENCY_MS
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
      options.onGossipActivityChange?.(next);
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
  gossipDecayTimer = setInterval(
    checkGossipActivity,
    GOSSIP_DECAY_MS,
  );

  function setFetchState(s: SnapshotFetchState) {
    fetchState = s;
    options.onFetchStateChange?.(s);
  }

  // --- Announce subscription ---

  // Writers already subscribe for re-announce mesh
  // in startReannounce; readers subscribe here.
  if (!isWriter) {
    log.debug("subscribing to announce topic:", topic);
    pubsub.subscribe(topic);
    markGossipSubscribed();
  }

  function scheduleRetry() {
    if (retryTimer || !pendingCid) return;
    retryAttempt++;
    if (retryAttempt > MAX_OUTER_RETRIES) {
      log.warn(
        "max retries exceeded for",
        pendingCid.slice(0, 16) + "...",
      );
      setFetchState({
        status: "failed",
        cid: pendingCid,
        error: "max retries exceeded",
      });
      return;
    }
    const nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
    setFetchState({
      status: "retrying",
      cid: pendingCid,
      attempt: retryAttempt,
      nextRetryAt,
    });
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!pendingCid || destroyed) return;
      const cidStr = pendingCid;
      log.debug(
        "retrying fetch for",
        cidStr.slice(0, 16) + "...",
      );
      setFetchState({
        status: "fetching",
        cid: cidStr,
        startedAt: Date.now(),
      });
      try {
        await onSnapshot(CIDClass.parse(cidStr));
        if (destroyed) return;
        hasAppliedSnapshot = true;
        pendingCid = null;
        retryAttempt = 0;
        setFetchState({ status: "idle" });
      } catch {
        if (!destroyed) scheduleRetry();
      }
    }, RETRY_INTERVAL_MS);
  }

  const announceHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;
    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;
    if (destroyed) return;

    touchGossip();

    // Handle pinner ack
    if (ann.ack) {
      if (ann.cid === ackedCid) {
        const isNew = !ackedBy.has(ann.ack.peerId);
        ackedBy.add(ann.ack.peerId);
        if (ann.ack.guaranteeUntil !== undefined) {
          const prev =
            pinnerGuarantees.get(
              ann.ack.peerId,
            ) ?? 0;
          pinnerGuarantees.set(
            ann.ack.peerId,
            Math.max(prev, ann.ack.guaranteeUntil),
          );
        }
        if (isNew) {
          log.debug(
            "ack from", ann.ack.peerId.slice(-8),
            "for", ann.cid.slice(0, 16) + "...",
          );
          options.onAck?.(ann.ack.peerId);
        }
      } else {
        log.debug(
          "ack cid mismatch:",
          ann.cid?.slice(0, 16),
          "expected:",
          ackedCid?.slice(0, 16),
        );
      }
      return;
    }

    log.debug(
      "announce received:",
      ann.cid.slice(0, 16) + "...",
    );
    if (ann.seq !== undefined) {
      latestAnnouncedSeq = Math.max(
        latestAnnouncedSeq, ann.seq,
      );
    }
    pendingCid = ann.cid;
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
        Promise.resolve(
          helia.blockstore.put(cid, blockBytes),
        ).catch((err) => {
          log.warn(
            "blockstore.put from announce failed:",
            err,
          );
        });
      } catch (err) {
        log.warn("block decode failed:", err);
      }
    }

    onSnapshot(cid).then(() => {
      if (destroyed) return;
      hasAppliedSnapshot = true;
      setFetchState({ status: "idle" });
      if (ann.cid !== lastAnnouncedCid) {
        lastAnnouncedCid = ann.cid;
        announceSnapshot(
          pubsub, appId, ipnsName, ann.cid,
          ann.seq,
        );
      }
    }).catch((err) => {
      if (destroyed) return;
      log.warn("announce apply failed:", err);
      scheduleRetry();
    });
  };

  pubsub.addEventListener(
    "message",
    announceHandler,
  );

  // --- IPNS polling fallback ---

  let stopWatch: (() => void) | null = null;
  if (ipnsPublicKeyBytes) {
    stopWatch = watchIPNS(
      getHelia(),
      ipnsPublicKeyBytes,
      async (cid) => {
        if (destroyed) return;
        const cidStr = cid.toString();
        retryAttempt = 0;
        setFetchState({
          status: "fetching",
          cid: cidStr,
          startedAt: Date.now(),
        });
        try {
          pendingCid = cidStr;
          await onSnapshot(cid);
          if (destroyed) return;
          hasAppliedSnapshot = true;
          pendingCid = null;
          setFetchState({ status: "idle" });
          if (cidStr !== lastAnnouncedCid) {
            lastAnnouncedCid = cidStr;
            announceSnapshot(
              pubsub, appId, ipnsName, cidStr,
              latestAnnouncedSeq || undefined,
            );
          }
        } catch {
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

  if (options.performInitialResolve &&
    ipnsPublicKeyBytes
  ) {
    const pubKeyBytes = ipnsPublicKeyBytes;
    setFetchState({
      status: "resolving",
      startedAt: Date.now(),
    });
    (async () => {
      try {
        const helia = getHelia();
        const tipCid = await resolveIPNS(
          helia,
          pubKeyBytes,
        );
        if (tipCid && !destroyed) {
          log.info(
            "IPNS resolved:",
            tipCid.toString(),
          );
          const cidStr = tipCid.toString();
          pendingCid = cidStr;
          retryAttempt = 0;
          setFetchState({
            status: "fetching",
            cid: cidStr,
            startedAt: Date.now(),
          });
          await onSnapshot(tipCid);
          if (destroyed) return;
          hasAppliedSnapshot = true;
          pendingCid = null;
          setFetchState({ status: "idle" });
          if (cidStr !== lastAnnouncedCid) {
            lastAnnouncedCid = cidStr;
            announceSnapshot(
              pubsub, appId, ipnsName, cidStr,
              latestAnnouncedSeq || undefined,
            );
          }
          log.info("initial snapshot applied");
        } else if (isWriter) {
          // Writer on a new doc — nothing published yet.
          // Go idle so the editor mounts immediately.
          log.debug(
            "IPNS resolve null (writer, new doc)",
          );
          setFetchState({ status: "idle" });
        } else {
          log.debug("IPNS resolve returned null");
          retryAttempt++;
          setFetchState({
            status: "retrying",
            cid: "",
            attempt: retryAttempt,
            nextRetryAt: Date.now() +
              RETRY_INTERVAL_MS,
          });
        }
      } catch (err) {
        log.warn(
          "initial snapshot load failed:", err,
        );
        scheduleRetry();
      }
    })();
  }

  // --- Re-announce timer (writers only) ---

  let announceTimer: ReturnType<
    typeof setInterval
  > | null = null;

  let reannounceGetCid:
    (() => CID | null) | null = null;
  let reannounceGetBlock:
    ((s: string) => Uint8Array | undefined) | null
    = null;
  let reannounceGetSeq:
    (() => number | null) | null = null;

  function doReannounce() {
    if (!reannounceGetCid) return;
    const cid = reannounceGetCid();
    if (!cid) return;
    const cidStr = cid.toString();
    const block = reannounceGetBlock?.(cidStr);
    if (block) {
      const helia = getHelia();
      Promise.resolve(
        helia.blockstore.put(cid, block),
      ).catch((err) => {
        log.warn("blockstore.put failed:", err);
      });
    }
    const seq =
      reannounceGetSeq?.() ?? undefined;
    log.debug(
      "re-announce:", cidStr.slice(0, 16),
    );
    try {
      announceSnapshot(
        pubsub,
        appId,
        ipnsName,
        cidStr,
        seq,
        block,
      );
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

      reannounceGetCid = getCid;
      reannounceGetBlock = getBlock;
      reannounceGetSeq = getSeq ?? null;

      announceTimer = setInterval(
        doReannounce, REANNOUNCE_MS,
      );
    },

    reannounceNow() {
      doReannounce();
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
      return Math.max(...pinnerGuarantees.values());
    },

    get gossipActivity(): GossipActivity {
      return currentGossipActivity();
    },

    destroy() {
      destroyed = true;
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = null;
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
      pubsub.removeEventListener(
        "message",
        announceHandler,
      );
    },
  };
}
