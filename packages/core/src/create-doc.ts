import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import { narrowCapability, buildUrl } from "@pokapali/capability";
import { hexToBytes } from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { SubdocManager } from "@pokapali/subdocs";
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import { decodeSnapshot } from "@pokapali/snapshot";
import { CID } from "multiformats/cid";
import { getHelia, releaseHelia } from "./helia.js";
import { publishIPNS, resolveIPNS, watchIPNS } from "./ipns-helpers.js";
import {
  announceTopic,
  announceSnapshot,
  parseAnnouncement,
  parseGuaranteeResponse,
  publishGuaranteeQuery,
  base64ToUint8,
  MAX_INLINE_BLOCK_BYTES,
} from "./announce.js";
import { uploadBlock } from "./block-upload.js";
import { fetchBlock as fetchBlockFromNetwork } from "./fetch-block.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import type { DocPersistence } from "./persistence.js";
import { createSnapshotLifecycle } from "./snapshot-lifecycle.js";
import { createRelaySharing } from "./relay-sharing.js";
import type { RelaySharing } from "./relay-sharing.js";
import { getNodeRegistry } from "./node-registry.js";
import { createTopologySharing } from "./topology-sharing.js";
import type { TopologySharing } from "./topology-sharing.js";
import { buildTopologyGraph } from "./topology-graph.js";
import type { TopologyGraph } from "./topology-graph.js";
import { createLogger } from "@pokapali/log";
import { buildDiagnostics } from "./doc-diagnostics.js";
import type { Diagnostics } from "./doc-diagnostics.js";
import { rotateDoc } from "./doc-rotate.js";
import type { RotateResult } from "./doc-rotate.js";
import { fetchVersionHistory } from "./fetch-version-history.js";
import type { VersionEntry } from "./fetch-version-history.js";
import {
  createAsyncQueue,
  scan,
  merge,
  reannounceFacts,
  createFeed,
} from "./sources.js";
import type { AsyncQueue, Feed, WritableFeed } from "./sources.js";
import { reduce } from "./reducers.js";
import { initialDocState, bestGuarantee, EMPTY_SET } from "./facts.js";
import type {
  Fact,
  DocState,
  DocStatus,
  SaveState,
  DocRole,
  SyncStatus,
  LoadingState,
  GossipActivity,
} from "./facts.js";
import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers } from "./interpreter.js";

const log = createLogger("core");

const REANNOUNCE_MS = 15_000;
const GUARANTEE_INITIAL_DELAY_MS = 3_000;
const GUARANTEE_REQUERY_MS = 5 * 60_000;

export type { DocStatus, SaveState, DocRole };

export interface VersionInfo {
  cid: CID;
  seq: number;
  ackedBy: ReadonlySet<string>;
  guaranteeUntil: number;
  retainUntil: number;
}

export interface SnapshotEvent {
  cid: CID;
  seq: number;
  ts: number;
  isLocal: boolean;
}

export interface DocUrls {
  readonly admin: string | null;
  readonly write: string | null;
  readonly read: string;
  /** Best available URL (admin > write > read). */
  readonly best: string;
}

export interface Doc {
  channel(name: string): Y.Doc;
  readonly provider: {
    readonly awareness: Awareness;
  };
  readonly awareness: Awareness;
  readonly capability: Capability;
  readonly urls: DocUrls;
  /** Role derived from capability. */
  readonly role: DocRole;
  invite(grant: CapabilityGrant): Promise<string>;
  /** Reactive status feed (useSyncExternalStore). */
  readonly status: Feed<DocStatus>;
  /** Reactive save-state feed (useSyncExternalStore). */
  readonly saveState: Feed<SaveState>;
  /** Peer IDs of relays discovered for this app. */
  readonly relays: ReadonlySet<string>;
  /** Sum of all Y.Doc state vector clocks. */
  readonly clockSum: number;
  /** Last IPNS sequence number used for publish. */
  readonly ipnsSeq: number | null;
  /** Highest seq seen in GossipSub announcements. */
  readonly latestAnnouncedSeq: number;
  /** Current loading lifecycle state. */
  readonly loadingState: LoadingState;
  /** True after first remote snapshot applied. */
  readonly hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  readonly ackedBy: ReadonlySet<string>;
  /** Latest guarantee-until timestamp across all
   *  pinners for the current CID, or null if none. */
  readonly guaranteeUntil: number | null;
  /** Latest retain-until timestamp across all
   *  pinners for the current CID, or null if none. */
  readonly retainUntil: number | null;
  /** CID of the current chain tip, or null if no
   *  snapshot has been created/applied yet. */
  readonly tipCid: CID | null;
  /** Reactive tip feed (useSyncExternalStore). */
  readonly tip: Feed<VersionInfo | null>;
  /** Reactive loading feed (useSyncExternalStore). */
  readonly loading: Feed<LoadingState>;
  /**
   * Resolves when the document has meaningful state:
   * either a remote snapshot was applied, initial IPNS
   * resolution found nothing to load, or the document
   * was locally created (resolves immediately).
   */
  ready(): Promise<void>;
  publish(): Promise<void>;
  rotate(): Promise<RotateResult>;
  on(event: "status", cb: (status: DocStatus) => void): void;
  on(event: "publish-needed", cb: () => void): void;
  on(event: "snapshot", cb: (e: SnapshotEvent) => void): void;
  on(event: "loading", cb: (state: LoadingState) => void): void;
  on(event: "ack", cb: (peerId: string) => void): void;
  on(event: "save", cb: (state: SaveState) => void): void;
  on(event: "node-change", cb: () => void): void;
  off(event: "status", cb: (status: DocStatus) => void): void;
  off(event: "publish-needed", cb: () => void): void;
  off(event: "snapshot", cb: (e: SnapshotEvent) => void): void;
  off(event: "loading", cb: (state: LoadingState) => void): void;
  off(event: "ack", cb: (peerId: string) => void): void;
  off(event: "save", cb: (state: SaveState) => void): void;
  off(event: "node-change", cb: () => void): void;
  diagnostics(): Diagnostics;
  /** Merged topology graph from own connections,
   *  peer-reported relays (awareness), and
   *  relay-to-relay edges (node-registry). */
  topologyGraph(): TopologyGraph;
  history(): Promise<
    Array<{
      cid: CID;
      seq: number;
      ts: number;
    }>
  >;
  /** Fetch version history from pinners (via HTTP),
   *  falling back to local chain walking. */
  versionHistory(): Promise<VersionEntry[]>;
  loadVersion(cid: CID): Promise<Record<string, Y.Doc>>;
  destroy(): void;
}

export interface DocParams {
  subdocManager: SubdocManager;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  origin: string;
  channels: string[];
  adminUrl: string | null;
  writeUrl: string | null;
  readUrl: string;
  signingKey: Ed25519KeyPair | null;
  readKey: CryptoKey | undefined;
  appId: string;
  primaryChannel: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  roomDiscovery?: RoomDiscovery;
  performInitialResolve?: boolean;
  /** y-indexeddb persistence handle — destroyed on
   *  doc teardown. */
  persistence?: DocPersistence | null;
  /** True when persistence is enabled and cached
   *  state may exist in IndexedDB. Triggers early
   *  markReady() after y-indexeddb sync. */
  hasCachedState?: boolean;
}

function computeStatus(
  syncStatus: SyncStatus,
  awarenessConnected: boolean,
  gossipActivity: GossipActivity,
): DocStatus {
  if (syncStatus === "connected") return "synced";
  if (syncStatus === "connecting") return "connecting";
  if (awarenessConnected) return "receiving";
  if (gossipActivity === "receiving") return "receiving";
  if (gossipActivity === "subscribed") {
    return "connecting";
  }
  return "offline";
}

function computeSaveState(isDirty: boolean, isSaving: boolean): SaveState {
  if (isSaving) return "saving";
  if (isDirty) return "dirty";
  return "saved";
}

// ── Loading state derivation from DocState ──────

function deriveLoadingState(state: DocState): LoadingState {
  if (state.ipnsStatus.phase === "resolving") {
    return {
      status: "resolving",
      startedAt: state.ipnsStatus.startedAt,
    };
  }
  for (const entry of state.chain.entries.values()) {
    if (entry.blockStatus === "fetching" && entry.fetchStartedAt) {
      return {
        status: "fetching",
        cid: entry.cid.toString(),
        startedAt: entry.fetchStartedAt,
      };
    }
  }
  for (const entry of state.chain.entries.values()) {
    if (entry.blockStatus === "failed") {
      return {
        status: "failed",
        cid: entry.cid.toString(),
        error: entry.lastError ?? "unknown",
      };
    }
  }
  return { status: "idle" };
}

function loadingStateChanged(a: LoadingState, b: LoadingState): boolean {
  if (a.status !== b.status) return true;
  if ("cid" in a && "cid" in b && a.cid !== b.cid) {
    return true;
  }
  return false;
}

/**
 * Populate the _meta subdoc with initial signing
 * key and namespace authorization entries.
 * Used by both create() and rotate().
 */
export function populateMeta(
  metaDoc: Y.Doc,
  signingPublicKey: Uint8Array,
  channelKeys: Record<string, Uint8Array>,
) {
  const canPush = metaDoc.getArray<Uint8Array>("canPushSnapshots");
  canPush.push([signingPublicKey]);
  const authorized = metaDoc.getMap("authorized");
  for (const [ch, key] of Object.entries(channelKeys)) {
    const arr = new Y.Array<Uint8Array>();
    authorized.set(ch, arr);
    arr.push([key]);
  }
}

export function createDoc(params: DocParams): Doc {
  const {
    subdocManager,
    syncManager,
    awarenessRoom,
    cap,
    keys,
    ipnsName,
    origin,
    channels,
    signingKey,
    readKey,
  } = params;

  let destroyed = false;
  let readyResolved = false;
  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  function markReady() {
    if (!readyResolved) {
      readyResolved = true;
      resolveReady?.();
    }
  }

  if (!params.performInitialResolve) {
    markReady();
  }

  // When persistence is enabled on open(), resolve
  // ready early once y-indexeddb has synced cached
  // state — the user can start editing immediately
  // while IPNS resolution + chain fetch continues
  // in the background.
  if (params.hasCachedState && params.persistence) {
    params.persistence.whenSynced.then(() => {
      markReady();
    });
  }

  function getHttpUrls(): string[] {
    const urls: string[] = [];
    const reg = getNodeRegistry();
    if (reg) {
      for (const node of reg.nodes.values()) {
        if (node.httpUrl) urls.push(node.httpUrl);
      }
    }
    return urls;
  }

  const snapshotLC = createSnapshotLifecycle({
    getHelia: () => getHelia(),
    httpUrls: getHttpUrls,
  });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function emit(event: string, ...args: unknown[]) {
    const cbs = listeners.get(event);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }

  // --- Status tracking (fallback for no-interpreter) --
  let gossipActivity: GossipActivity = "inactive";
  let isSaving = false;

  let lastStatus = computeStatus(
    syncManager.status,
    awarenessRoom.connected,
    gossipActivity,
  );
  let lastSaveState = computeSaveState(subdocManager.isDirty, isSaving);

  function checkStatus() {
    const next = computeStatus(
      syncManager.status,
      awarenessRoom.connected,
      gossipActivity,
    );
    if (next !== lastStatus) {
      lastStatus = next;
      statusFeed._update(next);
      emit("status", next);
    }
  }

  function checkSaveState() {
    const next = computeSaveState(subdocManager.isDirty, isSaving);
    if (next !== lastSaveState) {
      lastSaveState = next;
      saveStateFeed._update(next);
      emit("save", next);
    }
  }

  function computeClockSum(): number {
    let sum = 0;
    for (const ns of channels) {
      const sv = Y.encodeStateVector(subdocManager.subdoc(ns));
      const decoded = Y.decodeStateVector(sv);
      for (const clock of decoded.values()) {
        sum += clock;
      }
    }
    return sum;
  }

  // --- Interpreter state ---
  let interpreterState: DocState | null = null;
  let factQueue: AsyncQueue<Fact> | null = null;
  let interpreterAc: AbortController | null = null;
  let lastLocalPublishCid: string | null = null;
  let lastEmittedAcks = new Set<string>();
  let lastEmittedGuarantees = new Map<
    string,
    { guaranteeUntil: number; retainUntil: number }
  >();
  // --- Feeds ---
  const statusFeed: WritableFeed<DocStatus> = createFeed<DocStatus>(lastStatus);
  const saveStateFeed: WritableFeed<SaveState> =
    createFeed<SaveState>(lastSaveState);
  let lastTipInfo: VersionInfo | null = null;
  const tipFeed: WritableFeed<VersionInfo | null> =
    createFeed<VersionInfo | null>(null, (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.cid.equals(b.cid) &&
        a.seq === b.seq &&
        a.ackedBy === b.ackedBy &&
        a.guaranteeUntil === b.guaranteeUntil &&
        a.retainUntil === b.retainUntil
      );
    });
  const loadingFeed: WritableFeed<LoadingState> = createFeed<LoadingState>(
    { status: "idle" },
    (a, b) => !loadingStateChanged(a, b),
  );

  // --- Event bridges ---
  // Status and saveState are always computed
  // locally (synchronous). The interpreter also
  // tracks them internally but the local tracking
  // is authoritative for getters and events.

  subdocManager.on("dirty", () => {
    checkSaveState();
    emit("publish-needed");
    awarenessRoom.awareness.setLocalStateField("clockSum", computeClockSum());
    factQueue?.push({
      type: "content-dirty",
      ts: Date.now(),
      clockSum: computeClockSum(),
    });
  });

  syncManager.onStatusChange(() => {
    checkStatus();
    factQueue?.push({
      type: "sync-status-changed",
      ts: Date.now(),
      status: syncManager.status,
    });
  });
  awarenessRoom.onStatusChange(() => {
    checkStatus();
    factQueue?.push({
      type: "awareness-status-changed",
      ts: Date.now(),
      connected: awarenessRoom.connected,
    });
  });

  // If the subdoc is already dirty (e.g. _meta was
  // populated before we registered), fire the event
  // so the auto-save debounce starts.
  if (subdocManager.isDirty) {
    // Defer to next microtask so callers can attach
    // event listeners first.
    queueMicrotask(() => {
      checkSaveState();
      emit("publish-needed");
      factQueue?.push({
        type: "content-dirty",
        ts: Date.now(),
        clockSum: computeClockSum(),
      });
    });
  }

  // Share relay info with WebRTC peers via awareness.
  let relaySharing: RelaySharing | null = null;
  let topSharing: TopologySharing | null = null;
  let cleanupRelayConnect: (() => void) | null = null;
  if (params.roomDiscovery) {
    relaySharing = createRelaySharing({
      awareness: awarenessRoom.awareness,
      roomDiscovery: params.roomDiscovery,
    });
  }

  // Publish relay topology via awareness for graph.
  // Also forward node-registry changes as doc events.
  // When caps messages include addresses, feed them
  // to roomDiscovery so we can dial new relays.
  let fireGuaranteeQuery: (() => void) | null = null;
  const knownPinnerPids = new Set<string>();
  const nodeChangeHandler = () => {
    emit("node-change");
    const reg = getNodeRegistry();
    if (reg) {
      let newPinner = false;
      for (const node of reg.nodes.values()) {
        if (
          node.roles.includes("pinner") &&
          !knownPinnerPids.has(node.peerId)
        ) {
          knownPinnerPids.add(node.peerId);
          newPinner = true;
          factQueue?.push({
            type: "pinner-discovered",
            ts: Date.now(),
            peerId: node.peerId,
          });
        }
      }
      if (newPinner && fireGuaranteeQuery) {
        fireGuaranteeQuery();
      }
    }
    if (!params.roomDiscovery) return;
    if (!reg) return;
    const entries: {
      peerId: string;
      addrs: string[];
    }[] = [];
    for (const node of reg.nodes.values()) {
      if (node.addrs.length > 0) {
        entries.push({
          peerId: node.peerId,
          addrs: node.addrs,
        });
      }
    }
    if (entries.length > 0) {
      params.roomDiscovery.addExternalRelays(entries);
    }
  };
  try {
    const registry = getNodeRegistry();
    if (registry) {
      const helia = getHelia();
      topSharing = createTopologySharing({
        awareness: awarenessRoom.awareness,
        registry,
        libp2p: helia.libp2p,
      });
      registry.on("change", nodeChangeHandler);
    }
  } catch (err) {
    log.warn("topology sharing init skipped:", (err as Error)?.message ?? err);
  }

  // ── Interpreter setup ─────────────────────────
  let stopIPNSWatch: (() => void) | null = null;
  let initialQueryTimer: ReturnType<typeof setTimeout> | null = null;
  let guaranteeQueryInterval: ReturnType<typeof setInterval> | null = null;

  if (readKey && params.pubsub && params.appId) {
    const rk = readKey;
    const pubsub = params.pubsub;
    const appId = params.appId;
    const ipnsPublicKeyBytes = hexToBytes(ipnsName);

    log.debug("interpreter setup: pubsub=" + !!pubsub + " appId=" + appId);

    interpreterAc = new AbortController();
    const { signal } = interpreterAc;
    factQueue = createAsyncQueue<Fact>(signal);

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
    interpreterState = init;

    // --- GossipSub subscription + fact bridge ---
    const topic = announceTopic(appId);
    pubsub.subscribe(topic);
    factQueue.push({
      type: "gossip-subscribed",
      ts: Date.now(),
    });

    const fq = factQueue;
    const gossipHandler = (evt: CustomEvent) => {
      const { detail } = evt;
      if (detail?.topic !== topic) return;

      // Liveness fact for every message
      fq.push({
        type: "gossip-message",
        ts: Date.now(),
      });

      // Check guarantee response first
      const gResp = parseGuaranteeResponse(detail.data);
      if (gResp && gResp.ipnsName === ipnsName) {
        try {
          fq.push({
            type: "guarantee-received",
            ts: Date.now(),
            peerId: gResp.peerId,
            cid: CID.parse(gResp.cid),
            guaranteeUntil: gResp.guaranteeUntil ?? 0,
            retainUntil: gResp.retainUntil ?? 0,
          });
        } catch {
          // CID parse failure — skip
        }
        return;
      }

      const ann = parseAnnouncement(detail.data);
      if (!ann || ann.ipnsName !== ipnsName) return;

      // Ack handling
      if (ann.ack) {
        try {
          fq.push({
            type: "ack-received",
            ts: Date.now(),
            cid: CID.parse(ann.cid),
            peerId: ann.ack.peerId,
          });
        } catch {
          // CID parse failure — skip
        }
        if (
          ann.ack.guaranteeUntil !== undefined ||
          ann.ack.retainUntil !== undefined
        ) {
          try {
            fq.push({
              type: "guarantee-received",
              ts: Date.now(),
              peerId: ann.ack.peerId,
              cid: CID.parse(ann.cid),
              guaranteeUntil: ann.ack.guaranteeUntil ?? 0,
              retainUntil: ann.ack.retainUntil ?? 0,
            });
          } catch {
            // CID parse failure — skip
          }
        }
      }

      // CID discovery from announcement
      try {
        const cid = CID.parse(ann.cid);
        let block: Uint8Array | undefined;
        if (ann.block) {
          try {
            block = base64ToUint8(ann.block);
            // Store inline block for getBlock()
            snapshotLC.putBlock(ann.cid, block);
            const helia = getHelia();
            Promise.resolve(helia.blockstore.put(cid, block)).catch(() => {});
          } catch {
            // decode failure — skip inline block
          }
        }
        fq.push({
          type: "cid-discovered",
          ts: Date.now(),
          cid,
          source: "gossipsub",
          block,
          seq: ann.seq,
        });
      } catch {
        // CID parse failure — skip
      }
    };

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
        interpreterState = item.next;

        // Update tip feed (cached to avoid
        // allocations when nothing changed)
        const tip = item.next.chain.tip;
        if (tip) {
          const entry = item.next.chain.entries.get(tip.toString());
          const seq = entry?.seq ?? 0;
          const ackedBy = entry?.ackedBy ?? EMPTY_SET;
          const g = bestGuarantee(item.next.chain);
          if (
            !lastTipInfo ||
            !lastTipInfo.cid.equals(tip) ||
            lastTipInfo.seq !== seq ||
            lastTipInfo.ackedBy !== ackedBy ||
            lastTipInfo.guaranteeUntil !== g.guaranteeUntil ||
            lastTipInfo.retainUntil !== g.retainUntil
          ) {
            lastTipInfo = {
              cid: tip,
              seq,
              ackedBy,
              guaranteeUntil: g.guaranteeUntil,
              retainUntil: g.retainUntil,
            };
          }
          tipFeed._update(lastTipInfo);
        } else {
          if (lastTipInfo !== null) {
            lastTipInfo = null;
          }
          tipFeed._update(null);
        }

        // Derived loading state — feed handles dedup
        const prevLoading = loadingFeed.getSnapshot();
        const newLoading = deriveLoadingState(item.next);
        loadingFeed._update(newLoading);
        if (loadingStateChanged(prevLoading, newLoading)) {
          emit("loading", newLoading);
          // Ready check: if loading finished
          // without applying a snapshot, mount
          // the editor anyway.
          if (
            (newLoading.status === "idle" || newLoading.status === "failed") &&
            !readyResolved &&
            !item.next.chain.tip
          ) {
            markReady();
          }
        }
        yield item;
      }
    }

    // --- Effect handlers ---
    const effects: EffectHandlers = {
      fetchBlock: async (cid) => {
        try {
          const helia = getHelia();
          const block = await fetchBlockFromNetwork(helia, cid, {
            httpUrls: getHttpUrls(),
          });
          snapshotLC.putBlock(cid.toString(), block);
          return block;
        } catch {
          return null;
        }
      },

      getBlock: (cid) => {
        return snapshotLC.getBlock(cid.toString()) ?? null;
      },

      applySnapshot: async (cid, block) => {
        // Put block in helia blockstore so
        // applyRemote finds it immediately.
        const helia = getHelia();
        await Promise.resolve(helia.blockstore.put(cid, block));
        snapshotLC.putBlock(cid.toString(), block);

        const applied = await snapshotLC.applyRemote(cid, rk, (plaintext) =>
          subdocManager.applySnapshot(plaintext),
        );

        if (applied) {
          snapshotLC.setLastIpnsSeq(computeClockSum());
        }

        // Return seq from block metadata
        const node = decodeSnapshot(block);
        return { seq: node.seq };
      },

      decodeBlock: (block) => {
        try {
          const node = decodeSnapshot(block);
          return {
            prev: node.prev ?? undefined,
            seq: node.seq,
          };
        } catch {
          return {};
        }
      },

      announce: (cid, block, seq) => {
        if (block.length > MAX_INLINE_BLOCK_BYTES) {
          const urls = getHttpUrls();
          if (urls.length > 0) {
            uploadBlock(cid, block, urls).catch((err) => {
              log.warn("announce upload failed:", err);
            });
          }
          announceSnapshot(pubsub, appId, ipnsName, cid.toString(), seq).catch(
            (err) => {
              log.warn("announce failed:", err);
            },
          );
        } else {
          announceSnapshot(
            pubsub,
            appId,
            ipnsName,
            cid.toString(),
            seq,
            block,
          ).catch((err) => {
            log.warn("announce failed:", err);
          });
        }
      },

      markReady: () => markReady(),

      emitSnapshotApplied: (cid, seq) => {
        const cidStr = cid.toString();
        if (cidStr === lastLocalPublishCid) {
          lastLocalPublishCid = null;
          return;
        }
        emit("snapshot", {
          cid,
          seq,
          ts: Date.now(),
          isLocal: false,
        } satisfies SnapshotEvent);
      },

      emitAck: (_cid, ackedBy) => {
        for (const pid of ackedBy) {
          if (!lastEmittedAcks.has(pid)) {
            emit("ack", pid);
          }
        }
        lastEmittedAcks = new Set(ackedBy);
      },

      emitGossipActivity: (activity) => {
        gossipActivity = activity;
        checkStatus();
        emit("gossip-activity", activity);
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
            emit("ack", pid);
          }
        }
        lastEmittedGuarantees = new Map(guarantees);
      },

      // Status and saveState are tracked locally
      // (synchronous). The interpreter's derived
      // values are redundant — local handlers
      // already fire events.
      emitStatus: () => {},
      emitSaveState: () => {},
    };

    // --- Run interpreter ---
    runInterpreter(captureState(stateStream), effects, factQueue, signal).catch(
      (err) => {
        if (!signal.aborted) {
          log.warn("interpreter error:", err);
        }
      },
    );

    // --- IPNS initial resolve ---
    if (params.performInitialResolve) {
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
    stopIPNSWatch = watchIPNS(
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
    fireGuaranteeQuery = () => {
      publishGuaranteeQuery(pubsub, appId, ipnsName).catch((err) => {
        log.warn("guarantee query failed:", err);
      });
    };

    // Initial delay (3s) for mesh formation
    initialQueryTimer = setTimeout(() => {
      initialQueryTimer = null;
      if (!signal.aborted) {
        fireGuaranteeQuery!();
      }
    }, GUARANTEE_INITIAL_DELAY_MS);

    // Periodic re-query
    guaranteeQueryInterval = setInterval(() => {
      if (!signal.aborted) {
        fireGuaranteeQuery!();
      }
    }, GUARANTEE_REQUERY_MS);

    // --- Relay connect → push fact ---
    if (params.roomDiscovery) {
      const rd = params.roomDiscovery;
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
  }

  function teardown() {
    destroyed = true;
    // Interpreter cleanup
    interpreterAc?.abort();
    if (initialQueryTimer) {
      clearTimeout(initialQueryTimer);
    }
    if (guaranteeQueryInterval) {
      clearInterval(guaranteeQueryInterval);
    }
    if (stopIPNSWatch) {
      stopIPNSWatch();
      stopIPNSWatch = null;
    }
    cleanupRelayConnect?.();
    relaySharing?.destroy();
    topSharing?.destroy();
    try {
      getNodeRegistry()?.off("change", nodeChangeHandler);
    } catch (err) {
      log.warn("off('change') cleanup error:", (err as Error)?.message ?? err);
    }
    params.roomDiscovery?.stop();
    params.persistence?.destroy();
    syncManager.destroy();
    awarenessRoom.destroy();
    subdocManager.destroy();
    releaseHelia();
  }

  function assertNotDestroyed() {
    if (destroyed) {
      throw new Error("Doc destroyed");
    }
  }

  const providerObj = {
    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },
  };

  return {
    channel(name: string): Y.Doc {
      assertNotDestroyed();
      try {
        return subdocManager.subdoc(name);
      } catch {
        throw new Error(
          `Unknown channel "${name}". ` + "Configured: " + channels.join(", "),
        );
      }
    },

    get provider() {
      return providerObj;
    },

    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },

    get capability(): Capability {
      return cap;
    },

    get urls(): DocUrls {
      return {
        admin: params.adminUrl,
        write: params.writeUrl,
        read: params.readUrl,
        get best(): string {
          return params.adminUrl ?? params.writeUrl ?? params.readUrl;
        },
      };
    },

    get role(): DocRole {
      if (cap.isAdmin) return "admin";
      if (cap.channels.size > 0) return "writer";
      return "reader";
    },

    async invite(grant: CapabilityGrant): Promise<string> {
      assertNotDestroyed();
      if (grant.channels) {
        for (const ch of grant.channels) {
          if (!cap.channels.has(ch)) {
            throw new Error(
              `Cannot grant "${ch}" ` + "— not in own capability",
            );
          }
        }
      }
      if (grant.canPushSnapshots && !cap.canPushSnapshots) {
        throw new Error(
          "Cannot grant canPushSnapshots " + "— not in own capability",
        );
      }
      const narrowed = narrowCapability(keys, grant);
      return buildUrl(origin, ipnsName, narrowed);
    },

    status: statusFeed as Feed<DocStatus>,
    saveState: saveStateFeed as Feed<SaveState>,

    get relays(): ReadonlySet<string> {
      return params.roomDiscovery?.relayPeerIds ?? new Set();
    },

    get clockSum(): number {
      return computeClockSum();
    },

    get ipnsSeq(): number | null {
      return snapshotLC.lastIpnsSeq;
    },

    get latestAnnouncedSeq(): number {
      return interpreterState?.chain.maxSeq ?? 0;
    },

    get loadingState(): LoadingState {
      return loadingFeed.getSnapshot();
    },

    get hasAppliedSnapshot(): boolean {
      return (
        interpreterState?.chain.tip !== null &&
        interpreterState?.chain.tip !== undefined
      );
    },

    get ackedBy(): ReadonlySet<string> {
      if (!interpreterState?.chain.tip) {
        return EMPTY_SET;
      }
      const entry = interpreterState.chain.entries.get(
        interpreterState.chain.tip.toString(),
      );
      return entry?.ackedBy ?? EMPTY_SET;
    },

    get guaranteeUntil(): number | null {
      if (!interpreterState) return null;
      const g = bestGuarantee(interpreterState.chain);
      return g.guaranteeUntil || null;
    },

    get retainUntil(): number | null {
      if (!interpreterState) return null;
      const g = bestGuarantee(interpreterState.chain);
      return g.retainUntil || null;
    },

    get tipCid(): CID | null {
      return snapshotLC.prev;
    },

    tip: tipFeed as Feed<VersionInfo | null>,
    loading: loadingFeed as Feed<LoadingState>,

    ready(): Promise<void> {
      return readyPromise;
    },

    async publish(): Promise<void> {
      assertNotDestroyed();
      if (!cap.canPushSnapshots || !signingKey || !readKey) {
        return;
      }

      isSaving = true;
      checkSaveState();
      factQueue?.push({
        type: "publish-started",
        ts: Date.now(),
      });

      const plaintext = subdocManager.encodeAll();
      const clockSum = this.clockSum;
      let pushResult;
      try {
        pushResult = await snapshotLC.push(
          plaintext,
          readKey,
          signingKey,
          clockSum,
        );
      } catch (err) {
        isSaving = false;
        checkSaveState();
        factQueue?.push({
          type: "publish-failed",
          ts: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const { cid, block } = pushResult;

      // Store block for getBlock() and chain
      snapshotLC.putBlock(cid.toString(), block);

      // Suppress the interpreter's
      // emitSnapshotApplied for this CID since
      // we emit the local snapshot event below.
      lastLocalPublishCid = cid.toString();

      isSaving = false;
      checkSaveState();

      // Push chain entry + tip + success facts
      if (factQueue) {
        factQueue.push({
          type: "cid-discovered",
          ts: Date.now(),
          cid,
          source: "gossipsub",
          block,
          seq: pushResult.seq,
        });
        factQueue.push({
          type: "tip-advanced",
          ts: Date.now(),
          cid,
          seq: pushResult.seq,
        });
        factQueue.push({
          type: "publish-succeeded",
          ts: Date.now(),
          cid,
          seq: pushResult.seq,
        });
      }

      emit("snapshot", {
        cid,
        seq: pushResult.seq,
        ts: Date.now(),
        isLocal: true,
      } satisfies SnapshotEvent);

      // Persist to Helia + publish IPNS.
      // Fire-and-forget: don't block the UI on
      // slow DHT operations.
      // Announce is handled by the interpreter
      // via the publish-succeeded fact.
      const cidShort = cid.toString().slice(0, 16);
      log.info("publish: cid=" + cidShort + "... clockSum=" + clockSum);
      (async () => {
        const helia = getHelia();
        log.debug("blockstore.put...", cidShort + "...");
        await Promise.resolve(helia.blockstore.put(cid, block));
        log.debug("blockstore.put done," + " publishing IPNS...");
        await publishIPNS(helia, keys.ipnsKeyBytes!, cid, clockSum);
        log.debug("IPNS published");
      })().catch((err: unknown) => {
        log.error("IPNS publish failed:", err);
      });
    },

    async rotate(): Promise<RotateResult> {
      assertNotDestroyed();
      const result = await rotateDoc(
        {
          cap,
          keys,
          ipnsName,
          origin,
          channels,
          appId: params.appId,
          primaryChannel: params.primaryChannel,
          signalingUrls: params.signalingUrls,
          syncOpts: params.syncOpts,
          pubsub: params.pubsub,
          subdocManager,
        },
        createDoc,
        populateMeta,
      );
      teardown();
      return result as RotateResult;
    },

    /* eslint-disable @typescript-eslint/no-explicit-any */
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(event: string, cb: (...args: any[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    /* eslint-enable @typescript-eslint/no-explicit-any */

    diagnostics(): Diagnostics {
      assertNotDestroyed();
      const tip = interpreterState?.chain.tip;
      const tipEntry = tip
        ? interpreterState?.chain.entries.get(tip.toString())
        : undefined;
      const g = interpreterState
        ? bestGuarantee(interpreterState.chain)
        : { guaranteeUntil: 0, retainUntil: 0 };
      return buildDiagnostics({
        ackedBy: tipEntry?.ackedBy ?? EMPTY_SET,
        latestAnnouncedSeq: this.latestAnnouncedSeq,
        loadingState: this.loadingState,
        hasAppliedSnapshot: this.hasAppliedSnapshot,
        guaranteeUntil: g.guaranteeUntil || null,
        retainUntil: g.retainUntil || null,
        roomDiscovery: params.roomDiscovery,
        awareness: awarenessRoom.awareness,
        clockSum: computeClockSum(),
        ipnsSeq: snapshotLC.lastIpnsSeq,
      });
    },

    topologyGraph(): TopologyGraph {
      assertNotDestroyed();
      return buildTopologyGraph(this.diagnostics(), awarenessRoom.awareness);
    },

    async history() {
      assertNotDestroyed();
      return snapshotLC.history();
    },

    async versionHistory(): Promise<VersionEntry[]> {
      assertNotDestroyed();
      return fetchVersionHistory(getHttpUrls(), ipnsName, () =>
        snapshotLC.history(),
      );
    },

    async loadVersion(cid: CID) {
      assertNotDestroyed();
      if (!readKey) {
        throw new Error("No readKey available");
      }
      return snapshotLC.loadVersion(cid, readKey);
    },

    destroy(): void {
      if (destroyed) return;
      teardown();
    },
  } as Doc;
}
