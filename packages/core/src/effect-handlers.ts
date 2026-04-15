/**
 * Interpreter effect handlers — converts interpreter
 * side-effect directives into concrete actions
 * (announce, emit events, block fetch, etc.).
 *
 * Extracted from create-doc.ts to reduce its size.
 * Pure extraction, zero behavior change.
 *
 * @module
 */

import type { CID } from "multiformats/cid";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { PubSubLike } from "@pokapali/sync";
import type { EffectHandlers } from "./interpreter.js";
import type { SnapshotOps } from "./snapshot-ops.js";
import type { BlockResolver } from "./block-resolver.js";
import type { WritableFeed } from "./feed.js";
import type { ValidationErrorInfo } from "./doc-feeds.js";
import type { GossipActivity } from "./facts.js";
import type { SnapshotEvent } from "./create-doc.js";
import {
  announceTopic,
  announceSnapshot,
  signAnnouncementProof,
  MAX_INLINE_BLOCK_BYTES,
} from "./announce.js";
import { uploadBlock } from "./block-upload.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("effect-handlers");

// ── Options ────────────────────────────────────

export interface EffectHandlersOptions {
  resolver: BlockResolver;
  snapshotOps: SnapshotOps;
  pubsub: PubSubLike;
  networkId: string;
  appId: string;
  ipnsName: string;
  signingKey: Ed25519KeyPair | null;
  signal: AbortSignal;
  getHttpUrls: () => string[];
  markReady: () => void;
  validationErrorFeed: WritableFeed<ValidationErrorInfo | null>;
  snapshotEventFeed: WritableFeed<SnapshotEvent | null>;
  ackEventFeed: WritableFeed<string | null>;
  gossipActivityFeed: WritableFeed<GossipActivity>;
  onGossipActivity?: (activity: GossipActivity) => void;
}

// ── Return type ────────────────────────────────

export interface EffectHandlersResult {
  effects: EffectHandlers;
  /** Set from publish() to suppress the interpreter's
   *  emitSnapshotApplied for the local CID. */
  setLastLocalPublishCid(cid: string): void;
  /** Clean up pending announce retries. */
  cleanup(): void;
}

// ── Factory ────────────────────────────────────

export function createEffectHandlers(
  opts: EffectHandlersOptions,
): EffectHandlersResult {
  const {
    resolver,
    snapshotOps,
    pubsub,
    networkId,
    appId,
    ipnsName,
    signingKey,
    signal,
    getHttpUrls,
    markReady,
    validationErrorFeed,
    snapshotEventFeed,
    ackEventFeed,
    gossipActivityFeed,
    onGossipActivity,
  } = opts;

  // ── Mutable state ────────────────────────────

  let pendingAnnounceRetry: ReturnType<typeof setTimeout> | null = null;
  let lastLocalPublishCid: string | null = null;
  let lastEmittedAcks = new Set<string>();
  let lastEmittedGuarantees = new Map<
    string,
    { guaranteeUntil: number; retainUntil: number }
  >();

  // ── Announce handler ─────────────────────────

  function announce(cid: CID, block: Uint8Array, seq: number): void {
    // Cancel any pending retry from a previous
    // announce — superseded by this one.
    if (pendingAnnounceRetry !== null) {
      clearTimeout(pendingAnnounceRetry);
      pendingAnnounceRetry = null;
    }

    const cidStr = cid.toString();

    const doAnnounce = (proof?: string) => {
      if (block.length > MAX_INLINE_BLOCK_BYTES) {
        const urls = getHttpUrls();
        if (urls.length > 0) {
          uploadBlock(cid, block, urls, { signal }).catch((err) => {
            if (!signal.aborted) {
              log.warn("announce upload failed:", err);
            }
          });
        }
        announceSnapshot(
          pubsub,
          networkId,
          appId,
          ipnsName,
          cidStr,
          seq,
          undefined,
          undefined,
          undefined,
          proof,
        ).catch((err) => {
          log.warn("announce failed:", err);
        });
      } else {
        announceSnapshot(
          pubsub,
          networkId,
          appId,
          ipnsName,
          cidStr,
          seq,
          block,
          undefined,
          undefined,
          proof,
        ).catch((err) => {
          log.warn("announce failed:", err);
        });
      }
    };

    // Compute proof if we have the signing key,
    // then announce. Proof is async so we fire
    // immediately and let it resolve.
    const proofP = signingKey
      ? signAnnouncementProof(signingKey, ipnsName, cidStr)
      : Promise.resolve(undefined);

    const announceWithRetries = (proof: string | undefined) => {
      if (signal.aborted) return;

      // Announce immediately (may reach fanout
      // peers even without mesh).
      doAnnounce(proof);

      // Check mesh peers — if none, retry with
      // short interval until mesh forms. Prevents
      // silent publish drop when floodPublish is
      // false and the mesh hasn't formed yet.
      const topic = announceTopic(networkId, appId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gs = pubsub as any;
      const hasMesh = () => (gs.getMeshPeers?.(topic)?.length ?? 0) > 0;

      if (!hasMesh()) {
        log.info("no mesh peers for announce topic," + " scheduling retries");
        let retries = 0;
        const ANNOUNCE_RETRY_MAX = 14;
        const ANNOUNCE_RETRY_MS = 1_000;
        const scheduleRetry = () => {
          if (signal.aborted) return;
          if (retries >= ANNOUNCE_RETRY_MAX) return;
          retries++;
          pendingAnnounceRetry = setTimeout(() => {
            pendingAnnounceRetry = null;
            if (signal.aborted) return;
            if (hasMesh()) {
              log.info("mesh peers available," + " re-announcing");
              doAnnounce(proof);
            } else {
              scheduleRetry();
            }
          }, ANNOUNCE_RETRY_MS);
        };
        scheduleRetry();
      }
    };

    proofP.then(
      (proof) => announceWithRetries(proof),
      (err) => {
        log.warn("proof signing failed:", err);
        announceWithRetries(undefined);
      },
    );
  }

  // ── Effects object ───────────────────────────

  const effects: EffectHandlers = {
    fetchBlock: async (cid) => resolver.get(cid),
    getBlock: (cid) => resolver.getCached(cid),
    ...snapshotOps,

    announce,

    markReady: () => markReady(),

    emitSnapshotApplied: (cid, seq) => {
      validationErrorFeed._update(null);
      const cidStr = cid.toString();
      if (cidStr === lastLocalPublishCid) {
        lastLocalPublishCid = null;
        return;
      }
      snapshotEventFeed._update({
        cid,
        seq,
        ts: Date.now(),
        isLocal: false,
      });
    },

    emitAck: (_cid, ackedBy) => {
      for (const pid of ackedBy) {
        if (!lastEmittedAcks.has(pid)) {
          ackEventFeed._update(pid);
        }
      }
      lastEmittedAcks = new Set(ackedBy);
    },

    emitGossipActivity: (activity) => {
      onGossipActivity?.(activity);
      gossipActivityFeed._update(activity);
    },

    emitLoading: () => {
      // Loading state is derived in
      // captureState — this is a no-op.
    },

    emitGuarantee: (_cid, guarantees) => {
      for (const [pid, g] of guarantees) {
        const prev = lastEmittedGuarantees.get(pid);
        if (
          !prev ||
          prev.guaranteeUntil !== g.guaranteeUntil ||
          prev.retainUntil !== g.retainUntil
        ) {
          ackEventFeed._update(pid);
        }
      }
      lastEmittedGuarantees = new Map(guarantees);
    },

    emitValidationError: (info) => {
      validationErrorFeed._update(info);
    },
  };

  // ── Public API ───────────────────────────────

  return {
    effects,
    setLastLocalPublishCid(cid: string) {
      lastLocalPublishCid = cid;
    },
    cleanup() {
      if (pendingAnnounceRetry !== null) {
        clearTimeout(pendingAnnounceRetry);
        pendingAnnounceRetry = null;
      }
    },
  };
}
