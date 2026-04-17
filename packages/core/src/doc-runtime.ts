/**
 * doc-runtime.ts — Interpreter + P2P/gossip runtime for
 * a single Doc.
 *
 * Extracted from create-doc.ts. Given a live pubsub
 * transport (either provided inline or resolved after
 * Helia bootstrap), wires up:
 *   - the fact queue + interpreter scan pipeline
 *   - GossipSub subscription + fact bridge
 *   - store-hydration of cached version metadata
 *   - effect handlers (announce, emit events, ...)
 *   - HTTP tip pre-fetch + IPNS resolve/watch
 *   - periodic guarantee queries
 *   - relay-connect bookkeeping
 *
 * The runtime shares a small mutable `state` bag with
 * create-doc.ts so both sides see interpreter-derived
 * values (current DocState, last tip info, snapshot
 * history) in real time. Everything else flows through
 * the returned handles (factQueue, abort controller,
 * cleanup callbacks, timers).
 *
 * @module
 */

import type { Capability } from "@pokapali/capability";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { hexToBytes } from "@pokapali/crypto";
import type { Document } from "@pokapali/document";
import type { Codec } from "@pokapali/codec";
import type { Store } from "@pokapali/store";
import type { PubSubLike } from "@pokapali/sync";
import { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

import type { WritableFeed } from "./feed.js";
import type { BlockResolver } from "./block-resolver.js";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { ValidationErrorInfo } from "./doc-feeds.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import type { AsyncQueue } from "./async-utils.js";
import type {
  Fact,
  DocState,
  DocRole,
  LoadingState,
  GossipActivity,
  SnapshotHistory,
} from "./facts.js";
import type { VersionInfo, SnapshotEvent } from "./create-doc.js";

import { createAsyncQueue, scan, merge } from "./async-utils.js";
import { createSnapshotOps } from "./snapshot-ops.js";
import { createEffectHandlers } from "./effect-handlers.js";
import {
  createIngestSnapshot,
  type IngestOutcomeRecord,
  type IngestResult,
} from "./ingest-snapshot.js";
import { createGossipHandler } from "./doc-gossip-bridge.js";
import { fetchTipFromPinners } from "./fetch-tip.js";
import { getHelia } from "./helia.js";
import { resolveIPNS, watchIPNS } from "./ipns-helpers.js";
import { announceTopic, publishGuaranteeQuery } from "./announce.js";
import { reannounceFacts } from "./fact-sources.js";
import { runInterpreter } from "./interpreter.js";
import { reduce, reduceSnapshotHistory } from "./reducers.js";
import {
  initialDocState,
  bestGuarantee,
  INITIAL_SNAPSHOT_HISTORY,
  EMPTY_SET,
} from "./facts.js";
import { deriveStatus, deriveLoadingState } from "./doc-status.js";
import { loadingStateChanged } from "./doc-status.js";

const log = createLogger("core");

const REANNOUNCE_MS = 15_000;
const GUARANTEE_INITIAL_DELAY_MS = 3_000;
const GUARANTEE_REQUERY_MS = 5 * 60_000;

// -----------------------------------------------------
// Types
// -----------------------------------------------------

/**
 * Mutable state shared between the runtime (writer) and
 * create-doc.ts (reader — e.g. publish, diagnostics,
 * versionHistory). Fields are updated continuously as
 * the interpreter produces new DocStates.
 */
export interface DocRuntimeState {
  interpreterState: DocState | null;
  lastTipInfo: VersionInfo | null;
  localSnapshotHistory: SnapshotHistory | null;
}

/** Feeds the runtime writes to. */
export interface DocRuntimeFeeds {
  docStateFeed: WritableFeed<DocState>;
  tipFeed: WritableFeed<VersionInfo | null>;
  loadingFeed: WritableFeed<LoadingState>;
  backedUpFeed: WritableFeed<boolean>;
  snapshotEventFeed: WritableFeed<SnapshotEvent | null>;
  ackEventFeed: WritableFeed<string | null>;
  gossipActivityFeed: WritableFeed<GossipActivity>;
  validationErrorFeed: WritableFeed<ValidationErrorInfo>;
}

/** Options bag for {@link startDocRuntime}. */
export interface DocRuntimeOptions {
  // --- Identity / context ---
  appId: string;
  networkId: string;
  ipnsName: string;
  channels: string[];
  cap: Capability;
  readKey: CryptoKey;
  signingKey: Ed25519KeyPair | null;
  docCreatedAt: number;
  prefetchDepth?: number;
  performInitialResolve: boolean;

  // --- P2P transport ---
  pubsub: PubSubLike;
  roomDiscovery?: RoomDiscovery;

  // --- Data layer ---
  document?: Document;
  storeDocument?: Store.Document;
  codec: Codec;
  resolver: BlockResolver;
  snapshotCodec: SnapshotCodec;

  // --- Reactive outputs ---
  feeds: DocRuntimeFeeds;

  // --- Host callbacks ---
  computeClockSum: () => number;
  markReady: () => void;
  getHttpUrls: () => string[];
  updateVersionsFeed: () => void;
  isDestroyed: () => boolean;
  isReadyResolved: () => boolean;

  /**
   * Optional D3 telemetry hook — fires on every
   * `ingestSnapshot` terminal outcome (placed / pending
   * / rejected) including rescan retries. Consumers:
   * snapshot-exchange diagnostics view (#115).
   */
  onIngestOutcome?: (record: IngestOutcomeRecord) => void;

  // --- Shared mutable state ---
  state: DocRuntimeState;
}

/** Handles returned by {@link startDocRuntime}. */
export interface DocRuntimeResult {
  interpreterAc: AbortController;
  factQueue: AsyncQueue<Fact>;
  effectHandlersCleanup: () => void;
  setLastLocalPublishCid: (cid: string) => void;
  /**
   * Re-attempt placement for all sidebanded (unplaceable-
   * epoch) snapshots. Callers: reconciliation-wiring
   * fires this on reconcile-cycle-end, since peer-edit
   * arrivals are the only event class that can fill in
   * the missing intermediate epochs.
   */
  rescanPending: () => Promise<void>;
  /**
   * Ingest a snapshot block received from a peer via
   * snapshot exchange (catalog path). Runs the full
   * A3 pipeline: CID integrity → signature validation
   * → duplicate detection → structural placement →
   * apply/quarantine. Source is always "peer".
   */
  ingestSnapshot: (cid: CID, data: Uint8Array) => Promise<IngestResult>;
  fireGuaranteeQuery: () => void;
  stopIPNSWatch: () => void;
  initialQueryTimer: ReturnType<typeof setTimeout> | null;
  guaranteeQueryInterval: ReturnType<typeof setInterval>;
  cleanupRelayConnect: (() => void) | null;
}

// -----------------------------------------------------
// Implementation
// -----------------------------------------------------

/**
 * Start the P2P + interpreter layer for a Doc. Called
 * once the pubsub transport is available (inline or
 * after Helia bootstrap).
 */
export function startDocRuntime(opts: DocRuntimeOptions): DocRuntimeResult {
  const {
    appId,
    networkId,
    ipnsName,
    channels,
    cap,
    readKey,
    signingKey,
    docCreatedAt,
    prefetchDepth,
    performInitialResolve,
    pubsub,
    roomDiscovery,
    document,
    storeDocument,
    resolver,
    snapshotCodec,
    feeds,
    computeClockSum,
    markReady,
    getHttpUrls,
    updateVersionsFeed,
    isDestroyed,
    isReadyResolved,
    onIngestOutcome,
    state,
  } = opts;

  const {
    docStateFeed,
    tipFeed,
    loadingFeed,
    backedUpFeed,
    snapshotEventFeed,
    ackEventFeed,
    gossipActivityFeed,
    validationErrorFeed,
  } = feeds;

  const ipnsPublicKeyBytes = hexToBytes(ipnsName);

  log.debug("interpreter setup: pubsub=" + !!pubsub + " appId=" + appId);

  const interpreterAc = new AbortController();
  const { signal } = interpreterAc;
  const factQueue = createAsyncQueue<Fact>(signal);

  const role: DocRole = cap.isAdmin
    ? "admin"
    : cap.channels.size > 0
      ? "writer"
      : "reader";

  const init = initialDocState({
    ipnsName,
    role,
    channels,
    appId,
  });
  // Carry createdAt for mesh grace period
  init.connectivity = {
    ...init.connectivity,
    createdAt: docCreatedAt,
  };
  init.status = deriveStatus(init.connectivity);
  state.interpreterState = init;
  docStateFeed._update(init);

  const fq = factQueue;

  // --- Hydrate version index from Store ---
  const storeSnapshots = storeDocument?.snapshots;
  if (storeSnapshots) {
    storeSnapshots
      .loadAll()
      .then((cached) => {
        if (isDestroyed()) return;
        for (const e of cached) {
          try {
            const cid = CID.decode(e.cid);
            fq.push({
              type: "cid-discovered",
              ts: e.ts,
              cid,
              source: "cache",
              seq: e.seq,
              snapshotTs: e.ts,
            });

            // Populate localSnapshotHistory so
            // the version feed shows cached
            // snapshots immediately (cid-discovered
            // alone doesn't update snapshotHistory).
            state.localSnapshotHistory = reduceSnapshotHistory(
              state.localSnapshotHistory ??
                state.interpreterState?.snapshotHistory ??
                INITIAL_SNAPSHOT_HISTORY,
              {
                type: "snapshot-materialized",
                ts: e.ts,
                cid,
                seq: e.seq,
                channel: e.channel,
                epochIndex: e.epochIndex,
              },
            );
          } catch {
            // skip undecodable CIDs
          }
        }
        if (cached.length > 0) {
          updateVersionsFeed();
        }
        log.info("hydrated " + cached.length + " cached versions");
      })
      .catch((err) => {
        log.warn("version cache hydration failed:", err);
      });
  }

  // --- GossipSub subscription + fact bridge ---
  const topic = announceTopic(networkId, appId);
  pubsub.subscribe(topic);
  factQueue.push({
    type: "gossip-subscribed",
    ts: Date.now(),
  });
  const gossipHandler = createGossipHandler({
    topic,
    ipnsName,
    factQueue: fq,
    putBlock: (cid, block) => resolver.put(cid, block),
  });

  pubsub.addEventListener("message", gossipHandler as EventListener);

  // --- Reannounce source ---
  const reannounceSource = reannounceFacts(REANNOUNCE_MS, signal);

  // --- Scan pipeline ---
  const stateStream = scan(merge(factQueue, reannounceSource), reduce, init);

  // --- State capture + derived events ---
  async function* captureState(
    stream: AsyncIterable<{
      prev: DocState;
      next: DocState;
      fact: Fact;
    }>,
  ) {
    for await (const item of stream) {
      state.interpreterState = item.next;
      docStateFeed._update(item.next);

      // Update tip feed (cached to avoid
      // allocations when nothing changed)
      const tip = item.next.chain.tip;
      if (tip) {
        const entry = item.next.chain.entries.get(tip.toString());
        const seq = entry?.seq ?? 0;
        const ackedBy = entry?.ackedBy ?? EMPTY_SET;
        const g = bestGuarantee(item.next.chain);
        if (
          !state.lastTipInfo ||
          !state.lastTipInfo.cid.equals(tip) ||
          state.lastTipInfo.seq !== seq ||
          state.lastTipInfo.ackedBy !== ackedBy ||
          state.lastTipInfo.guaranteeUntil !== g.guaranteeUntil ||
          state.lastTipInfo.retainUntil !== g.retainUntil
        ) {
          state.lastTipInfo = {
            cid: tip,
            seq,
            ackedBy,
            guaranteeUntil: g.guaranteeUntil,
            retainUntil: g.retainUntil,
          };
        }
        tipFeed._update(state.lastTipInfo);
      } else {
        if (state.lastTipInfo !== null) {
          state.lastTipInfo = null;
        }
        tipFeed._update(null);
      }

      // Derived backedUp — true when current tip
      // has at least one pinner ack.
      backedUpFeed._update((state.lastTipInfo?.ackedBy.size ?? 0) > 0);

      // Derived loading state — feed handles dedup
      const prevLoading = loadingFeed.getSnapshot();
      const newLoading = deriveLoadingState(item.next);
      loadingFeed._update(newLoading);
      if (loadingStateChanged(prevLoading, newLoading)) {
        // Ready check: if loading finished
        // without applying a snapshot, mount
        // the editor anyway.
        if (
          (newLoading.status === "idle" || newLoading.status === "failed") &&
          !isReadyResolved() &&
          !item.next.chain.tip
        ) {
          markReady();
        }
      }

      // Version history feed — update when chain
      // changes (structural sharing: cheap check)
      if (item.next.chain !== item.prev.chain) {
        updateVersionsFeed();
      }

      yield item;
    }
  }

  // --- Ingest orchestrator ---
  // Owns `lastLocalPublishCid` at runtime scope so both
  // the ingest source-dispatch (snapshot-ops applySnapshot
  // shim) and the effect-handlers' emitSnapshotApplied
  // echo suppression close over the same flag. Post-A4,
  // peer blocks primarily arrive via catalog exchange →
  // onSnapshotReceived, but the GossipSub path still
  // reaches here until interpreter-double-apply cutover.
  let lastLocalPublishCid: string | null = null;
  const ingest = createIngestSnapshot({
    snapshotCodec,
    document,
    resolver,
    readKey,
    getClockSum: computeClockSum,
    getState: () => ({
      chain: state.interpreterState?.chain ?? init.chain,
    }),
    onIngestOutcome,
  });

  // --- Effect handlers ---
  const snapshotOps = createSnapshotOps({
    ingest,
    resolveSource: (cid) =>
      lastLocalPublishCid !== null && cid.toString() === lastLocalPublishCid
        ? "local"
        : "peer",
  });

  const effectHandlers = createEffectHandlers({
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
    getLastLocalPublishCid: () => lastLocalPublishCid,
    clearLastLocalPublishCid: () => {
      lastLocalPublishCid = null;
    },
  });
  const { effects, cleanup: effectHandlersCleanup } = effectHandlers;

  const setLastLocalPublishCid = (cid: string) => {
    lastLocalPublishCid = cid;
  };

  // --- Run interpreter ---
  runInterpreter(captureState(stateStream), effects, factQueue, signal, {
    prefetchDepth,
  }).catch((err) => {
    if (!signal.aborted) {
      log.warn("interpreter error:", err);
      // Ensure ready() resolves even if the
      // interpreter crashes — otherwise the doc
      // hangs permanently with no recovery path.
      markReady();
    }
  });

  // --- HTTP tip fetch (fastest path) ---
  // Fire in parallel with IPNS — whichever
  // resolves first pushes cid-discovered.
  // This is purely additive: IPNS drives loading
  // state (ipns-resolve-started/completed), so
  // HTTP failure never blocks the loading
  // lifecycle.
  if (performInitialResolve) {
    (async () => {
      try {
        const urls = getHttpUrls();
        if (urls.length === 0) return;
        const tip = await fetchTipFromPinners(urls, ipnsName, signal);
        if (signal.aborted || !tip) return;
        resolver.put(tip.cid, tip.block);
        const now = Date.now();
        fq.push({
          type: "cid-discovered",
          ts: now,
          cid: tip.cid,
          source: "http-tip",
          block: tip.block,
          seq: tip.seq,
          snapshotTs: tip.ts,
        });
        if (tip.guaranteeUntil !== undefined || tip.retainUntil !== undefined) {
          fq.push({
            type: "guarantee-received",
            ts: now,
            peerId: tip.peerId,
            cid: tip.cid,
            guaranteeUntil: tip.guaranteeUntil ?? 0,
            retainUntil: tip.retainUntil ?? 0,
          });
        }
      } catch (err) {
        log.warn("HTTP tip fetch failed:", (err as Error)?.message ?? err);
      }
    })();
  }

  // --- IPNS initial resolve ---
  if (performInitialResolve) {
    fq.push({
      type: "ipns-resolve-started",
      ts: Date.now(),
    });
    (async () => {
      try {
        const helia = getHelia();
        const tipCid = await resolveIPNS(helia, ipnsPublicKeyBytes);
        if (signal.aborted) return;
        if (tipCid) {
          log.info("IPNS resolved:", tipCid.toString());
          fq.push({
            type: "cid-discovered",
            ts: Date.now(),
            cid: tipCid,
            source: "ipns",
          });
        }
        fq.push({
          type: "ipns-resolve-completed",
          ts: Date.now(),
          cid: tipCid,
        });
      } catch (err) {
        log.warn("initial IPNS resolve failed:", err);
        fq.push({
          type: "ipns-resolve-completed",
          ts: Date.now(),
          cid: null,
        });
      }
    })();
  }

  // --- IPNS polling ---
  const stopIPNSWatch = watchIPNS(
    getHelia(),
    ipnsPublicKeyBytes,
    (cid) => {
      if (!signal.aborted) {
        fq.push({
          type: "cid-discovered",
          ts: Date.now(),
          cid,
          source: "ipns",
        });
      }
    },
    {
      onPollStart: () => {
        if (!signal.aborted) {
          fq.push({
            type: "ipns-resolve-started",
            ts: Date.now(),
          });
        }
      },
    },
  );

  // --- Guarantee queries ---
  const fireGuaranteeQuery = () => {
    publishGuaranteeQuery(pubsub, networkId, appId, ipnsName).catch((err) => {
      log.warn("guarantee query failed:", err);
    });
  };

  // Initial delay (3s) for mesh formation
  let initialQueryTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => {
      initialQueryTimer = null;
      if (!signal.aborted) {
        fireGuaranteeQuery();
      }
    },
    GUARANTEE_INITIAL_DELAY_MS,
  );

  // Periodic re-query
  const guaranteeQueryInterval = setInterval(() => {
    if (!signal.aborted) {
      fireGuaranteeQuery();
    }
  }, GUARANTEE_REQUERY_MS);

  // --- Relay connect → push fact ---
  let cleanupRelayConnect: (() => void) | null = null;
  if (roomDiscovery) {
    const rd = roomDiscovery;
    const connectHandler = (evt: CustomEvent) => {
      const pid = evt.detail?.toString?.() ?? "";
      if (rd.relayPeerIds.has(pid)) {
        fq.push({
          type: "relay-connected",
          ts: Date.now(),
          peerId: pid,
        });
      }
    };
    const helia = getHelia();
    helia.libp2p.addEventListener("peer:connect", connectHandler);
    cleanupRelayConnect = () => {
      helia.libp2p.removeEventListener("peer:connect", connectHandler);
    };
  }

  // Cleanup GossipSub on abort
  signal.addEventListener(
    "abort",
    () => {
      pubsub.removeEventListener("message", gossipHandler as EventListener);
      pubsub.unsubscribe(topic);
    },
    { once: true },
  );

  return {
    interpreterAc,
    factQueue,
    effectHandlersCleanup,
    setLastLocalPublishCid,
    rescanPending: () => ingest.rescanPending(),
    ingestSnapshot: (cid: CID, data: Uint8Array) =>
      ingest.ingestSnapshot(cid, data, {
        source: "peer",
      }),
    fireGuaranteeQuery,
    stopIPNSWatch,
    initialQueryTimer,
    guaranteeQueryInterval,
    cleanupRelayConnect,
  };
}
