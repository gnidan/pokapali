import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import type { PubSubLike } from "@pokapali/sync";
import {
  announceTopic,
  parseAnnouncement,
  announceSnapshot,
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
  const ackedBy = new Set<string>();
  let retryTimer: ReturnType<
    typeof setTimeout
  > | null = null;

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

    // Handle pinner ack
    if (ann.ack) {
      if (ann.cid === ackedCid) {
        const isNew = !ackedBy.has(ann.ack.peerId);
        ackedBy.add(ann.ack.peerId);
        if (isNew) {
          log.debug(
            "ack from", ann.ack.peerId.slice(-8),
            "for", ann.cid.slice(0, 16) + "...",
          );
          options.onAck?.(ann.ack.peerId);
        }
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
    onSnapshot(cid).then(() => {
      if (destroyed) return;
      hasAppliedSnapshot = true;
      setFetchState({ status: "idle" });
      announceSnapshot(
        pubsub, appId, ipnsName, ann.cid,
        ann.seq,
      );
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
          announceSnapshot(
            pubsub, appId, ipnsName, cidStr,
            latestAnnouncedSeq || undefined,
          );
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
          announceSnapshot(
            pubsub, appId, ipnsName, cidStr,
            latestAnnouncedSeq || undefined,
          );
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
    announceSnapshot(
      pubsub,
      appId,
      ipnsName,
      cidStr,
      seq,
    );
  }

  return {
    startReannounce(getCid, getBlock, getSeq) {
      if (announceTimer) return;
      // Subscribe so writer joins the GossipSub
      // mesh for the announce topic.
      pubsub.subscribe(topic);

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

    destroy() {
      destroyed = true;
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = null;
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
