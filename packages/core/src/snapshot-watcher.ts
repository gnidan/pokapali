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

const REANNOUNCE_MS = 30_000;
const RETRY_INTERVAL_MS = 30_000;

export interface SnapshotWatcherOptions {
  appId: string;
  ipnsName: string;
  pubsub: PubSubLike;
  getHelia: () => Helia;
  isWriter: boolean;
  ipnsPublicKeyBytes?: Uint8Array;
  onSnapshot: (cid: CID) => Promise<void>;
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
  readonly latestAnnouncedSeq: number;
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
  let retryTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  // --- Announce subscription ---

  // Writers already subscribe for re-announce mesh
  // in startReannounce; readers subscribe here.
  if (!isWriter) {
    log.debug("subscribing to announce topic:", topic);
    pubsub.subscribe(topic);
  }

  function scheduleRetry() {
    if (retryTimer || !pendingCid) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!pendingCid || destroyed) return;
      const cidStr = pendingCid;
      log.debug(
        "retrying fetch for",
        cidStr.slice(0, 16) + "...",
      );
      try {
        await onSnapshot(CIDClass.parse(cidStr));
        pendingCid = null;
      } catch {
        scheduleRetry();
      }
    }, RETRY_INTERVAL_MS);
  }

  const announceHandler = (evt: CustomEvent) => {
    const { detail } = evt;
    if (detail?.topic !== topic) return;
    const ann = parseAnnouncement(detail.data);
    if (!ann || ann.ipnsName !== ipnsName) return;
    log.debug(
      "announce received:",
      ann.cid.slice(0, 16) + "...",
    );
    if (destroyed) return;
    if (ann.seq !== undefined) {
      latestAnnouncedSeq = Math.max(
        latestAnnouncedSeq, ann.seq,
      );
    }
    pendingCid = ann.cid;
    const cid = CIDClass.parse(ann.cid);
    onSnapshot(cid).then(() => {
      announceSnapshot(
        pubsub, appId, ipnsName, ann.cid,
      );
    }).catch((err) => {
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
        try {
          const cidStr = cid.toString();
          pendingCid = cidStr;
          await onSnapshot(cid);
          pendingCid = null;
          announceSnapshot(
            pubsub, appId, ipnsName, cidStr,
          );
        } catch {
          scheduleRetry();
        }
      },
    );
  }

  // --- Initial IPNS resolve ---

  if (options.performInitialResolve &&
    ipnsPublicKeyBytes
  ) {
    const pubKeyBytes = ipnsPublicKeyBytes;
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
          await onSnapshot(tipCid);
          pendingCid = null;
          announceSnapshot(
            pubsub, appId, ipnsName, cidStr,
          );
          log.info("initial snapshot applied");
        } else {
          log.debug("IPNS resolve returned null");
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

  return {
    startReannounce(getCid, getBlock, getSeq) {
      if (announceTimer) return;
      // Subscribe so writer joins the GossipSub
      // mesh for the announce topic.
      pubsub.subscribe(topic);
      announceTimer = setInterval(() => {
        const cid = getCid();
        if (!cid) return;
        const cidStr = cid.toString();
        const block = getBlock(cidStr);
        if (block) {
          const helia = getHelia();
          Promise.resolve(
            helia.blockstore.put(cid, block),
          ).catch((err) => {
            log.warn("blockstore.put failed:", err);
          });
        }
        const seq = getSeq?.() ?? undefined;
        announceSnapshot(
          pubsub,
          appId,
          ipnsName,
          cidStr,
          seq,
        );
      }, REANNOUNCE_MS);
    },

    get latestAnnouncedSeq() {
      return latestAnnouncedSeq;
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
