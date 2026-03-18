import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import { narrowCapability, buildUrl } from "@pokapali/capability";
import { hexToBytes, bytesToHex } from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { ParticipantAwareness } from "./identity.js";
import {
  createClientIdMapping,
  setupParticipantAwareness,
} from "./doc-identity.js";
import type { IdentityMap } from "./doc-identity.js";
import type { SubdocManager } from "@pokapali/subdocs";
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import { createSnapshotOps } from "./snapshot-ops.js";
import { CID } from "multiformats/cid";
import { getHelia, releaseHelia } from "./helia.js";
import { publishIPNS, resolveIPNS, watchIPNS } from "./ipns-helpers.js";
import {
  announceTopic,
  announceSnapshot,
  signAnnouncementProof,
  publishGuaranteeQuery,
  MAX_INLINE_BLOCK_BYTES,
} from "./announce.js";
import { createGossipHandler } from "./doc-gossip-bridge.js";
import { uploadBlock } from "./block-upload.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import type { DocPersistence } from "./persistence.js";
import { createBlockResolver } from "./block-resolver.js";
import { createSnapshotCodec } from "./snapshot-codec.js";
import { readVersionCache, writeVersionCache } from "./version-cache.js";
import type { CachedVersionEntry } from "./version-cache.js";
import { fetchTipFromPinners } from "./fetch-tip.js";
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
import { DestroyedError, PermissionError, TimeoutError } from "./errors.js";
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
import { reduce, reduceChain } from "./reducers.js";
import {
  initialDocState,
  bestGuarantee,
  deriveVersionHistory,
  EMPTY_SET,
} from "./facts.js";
import type {
  Fact,
  DocState,
  ChainState,
  DocStatus,
  SaveState,
  DocRole,
  LoadingState,
  GossipActivity,
  VersionHistory,
} from "./facts.js";
import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers } from "./interpreter.js";
import {
  computeStatus,
  computeSaveState,
  deriveLoadingState,
  loadingStateChanged,
  MESH_GRACE_MS,
} from "./doc-status.js";

const log = createLogger("core");

const REANNOUNCE_MS = 15_000;
const GUARANTEE_INITIAL_DELAY_MS = 3_000;
const GUARANTEE_REQUERY_MS = 5 * 60_000;

export type { DocStatus, SaveState, DocRole };

/**
 * Information about a single version in the document
 * chain. Returned by the {@link Doc.versions} feed.
 */
export interface VersionInfo {
  /** Content identifier for this version's snapshot. */
  cid: CID;
  /** Monotonically increasing sequence number. */
  seq: number;
  /** Peer IDs of pinners that acknowledged this CID. */
  ackedBy: ReadonlySet<string>;
  /**
   * Timestamp (ms) until which pinners guarantee
   * availability of this version. Monotonic per CID.
   */
  guaranteeUntil: number;
  /**
   * Timestamp (ms) until which pinners will retain the
   * block, even after re-announce stops. Always >=
   * {@link guaranteeUntil}.
   */
  retainUntil: number;
}

/**
 * Emitted when a snapshot is created or received.
 * Subscribe via {@link Doc.snapshotEvents}.
 */
export interface SnapshotEvent {
  /** Content identifier for the snapshot block. */
  cid: CID;
  /** Sequence number in the document chain. */
  seq: number;
  /** Unix timestamp (ms) when the snapshot was taken. */
  ts: number;
  /** True if this snapshot was created locally. */
  isLocal: boolean;
}

/**
 * Capability URLs for sharing document access.
 * Available via {@link Doc.urls}.
 */
export interface DocUrls {
  /** Admin URL (full control), or null if read/write. */
  readonly admin: string | null;
  /** Write URL (edit access), or null if read-only. */
  readonly write: string | null;
  /** Read-only URL. Always available. */
  readonly read: string;
  /** Best available URL (admin > write > read). */
  readonly best: string;
}

export interface Doc {
  channel(name: string): Y.Doc;
  /** @deprecated Use `doc.awareness` directly. */
  readonly provider: {
    readonly awareness: Awareness;
  };
  readonly awareness: Awareness;
  readonly capability: Capability;
  /** All channels configured for this app. Compare
   *  with `capability.channels` to find channels
   *  the current user cannot write (needs re-invite
   *  from an admin). */
  readonly configuredChannels: readonly string[];
  readonly urls: DocUrls;
  /** Role derived from capability. */
  readonly role: DocRole;
  invite(grant: CapabilityGrant): Promise<string>;

  // ── Reactive Feeds ─────────────────────────
  /** Reactive status feed (useSyncExternalStore). */
  readonly status: Feed<DocStatus>;
  /** Reactive save-state feed. */
  readonly saveState: Feed<SaveState>;
  /** Reactive tip feed. */
  readonly tip: Feed<VersionInfo | null>;
  /** Reactive loading feed. */
  readonly loading: Feed<LoadingState>;
  /** True when current tip has at least one
   *  pinner ack. Resets on new publish. */
  readonly backedUp: Feed<boolean>;
  /** Reactive version history feed. Updates as
   *  chain walks discover and fetch entries. */
  readonly versions: Feed<VersionHistory>;
  /** Latest snapshot event (local or remote).
   *  Fires on every snapshot — never deduplicates. */
  readonly snapshotEvents: Feed<SnapshotEvent | null>;
  /** Reactive gossip activity state. */
  readonly gossipActivity: Feed<GossipActivity>;
  /** Persistent clientID→pubkey mapping from _meta.
   *  Updates reactively as peers register. */
  readonly clientIdMapping: Feed<ReadonlyMap<number, ClientIdentityInfo>>;
  /** Last IDB persistence error, or null. Fires
   *  when block/doc writes to IndexedDB fail
   *  (e.g. quota exceeded in incognito). */
  readonly lastPersistenceError: Feed<string | null>;
  /** Last snapshot validation error, or null.
   *  Fires when a remote snapshot fails signature
   *  validation. Resets to null on next successful
   *  tip advance. */
  readonly lastValidationError: Feed<{
    cid: string;
    message: string;
  } | null>;

  // ── Derived getters (from tip Feed) ────────
  /** @deprecated Use `tip.getSnapshot()?.cid`. */
  readonly tipCid: CID | null;
  /** @deprecated Use `tip.getSnapshot()?.ackedBy`. */
  readonly ackedBy: ReadonlySet<string>;
  /** @deprecated Use
   *  `tip.getSnapshot()?.guaranteeUntil`. */
  readonly guaranteeUntil: number | null;
  /** @deprecated Use
   *  `tip.getSnapshot()?.retainUntil`. */
  readonly retainUntil: number | null;
  /** @deprecated Use `loading.getSnapshot()`. */
  readonly loadingState: LoadingState;

  // ── Lifecycle ──────────────────────────────
  /**
   * Resolves when the document has meaningful state:
   * either a remote snapshot was applied, initial
   * IPNS resolution found nothing to load, or the
   * document was locally created.
   *
   * @param options.timeoutMs - Optional timeout in ms.
   *   Rejects with Error("ready() timed out") if
   *   the document isn't ready within the timeout.
   */
  ready(options?: { timeoutMs?: number }): Promise<void>;
  publish(): Promise<void>;
  rotate(): Promise<RotateResult>;
  destroy(): void;

  // ── Identity & authorization ───────────────
  /** This device's identity public key (hex). */
  readonly identityPubkey: string | null;
  authorize(pubkey: string): void;
  deauthorize(pubkey: string): void;
  readonly authorizedPublishers: ReadonlySet<string>;
  /** Participants currently visible via awareness. */
  readonly participants: ReadonlyMap<number, ParticipantInfo>;

  // ── Diagnostics ────────────────────────────
  diagnostics(): Diagnostics;
  topologyGraph(): TopologyGraph;
  /** Fetch version history from pinners (via HTTP),
   *  falling back to local chain walking. */
  versionHistory(): Promise<VersionEntry[]>;
  loadVersion(cid: CID): Promise<Record<string, Y.Doc>>;

  // ── Deprecated ─────────────────────────────
  /** @deprecated Use Feed subscriptions instead. */
  on(event: "status", cb: (status: DocStatus) => void): void;
  on(event: "publish-needed", cb: () => void): void;
  on(event: "snapshot", cb: (e: SnapshotEvent) => void): void;
  on(event: "loading", cb: (state: LoadingState) => void): void;
  on(event: "ack", cb: (peerId: string) => void): void;
  on(event: "save", cb: (state: SaveState) => void): void;
  on(event: "node-change", cb: () => void): void;
  /** @deprecated Use Feed subscriptions instead. */
  off(event: "status", cb: (status: DocStatus) => void): void;
  off(event: "publish-needed", cb: () => void): void;
  off(event: "snapshot", cb: (e: SnapshotEvent) => void): void;
  off(event: "loading", cb: (state: LoadingState) => void): void;
  off(event: "ack", cb: (peerId: string) => void): void;
  off(event: "save", cb: (state: SaveState) => void): void;
  off(event: "node-change", cb: () => void): void;
}

export interface ParticipantInfo {
  pubkey: string;
  displayName?: string;
}

export interface ClientIdentityInfo {
  pubkey: string;
  verified: boolean;
}

/** P2P dependencies resolved after Helia bootstrap. */
export interface P2PDeps {
  pubsub: PubSubLike;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  roomDiscovery: RoomDiscovery;
}

export interface DocParams {
  subdocManager: SubdocManager;
  syncManager?: SyncManager;
  awarenessRoom?: AwarenessRoom;
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
  /** Device identity keypair (always present). Used
   *  for publisher attribution and participant
   *  awareness. */
  identity?: Ed25519KeyPair;
  /** Standalone awareness for immediate use before
   *  P2P connects. Used when awarenessRoom is
   *  deferred via p2pReady. */
  awareness?: Awareness;
  /** Promise that resolves with P2P deps after
   *  Helia bootstrap. When provided, the interpreter
   *  and sync/gossip layer start when this resolves.
   *  Rejection is handled gracefully — doc continues
   *  in local-only mode. */
  p2pReady?: Promise<P2PDeps>;
}

// Pure status derivation functions extracted to
// doc-status.ts (computeStatus, computeSaveState,
// deriveLoadingState, loadingStateChanged).

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
  //
  // Note: hasCachedState is true whenever persistence
  // is enabled, even on first open (empty DB).
  // y-indexeddb can't distinguish "synced with data"
  // from "synced with nothing," so first-open shows
  // a brief blank editor until IPNS resolves. This
  // is acceptable — the alternative (blocking on
  // IPNS) is much slower on repeat visits.
  if (params.hasCachedState && params.persistence) {
    params.persistence.whenSynced.then(
      () => markReady(),
      // IDB failure is non-fatal — degrade to
      // in-memory, IPNS path will markReady later.
      () => markReady(),
    );
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

  const resolver = createBlockResolver({
    getHelia: () => getHelia(),
    httpUrls: getHttpUrls,
    onWriteError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      persistenceErrorFeed._update(msg);
    },
  });
  const snapshotLC = createSnapshotCodec({
    resolver,
  });
  // Event subscriptions — backed by Feeds.
  // Maps event name → (callback → unsubscribe).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type EventCb = (...args: any[]) => void;
  const eventSubs = new Map<string, Map<EventCb, () => void>>();

  // --- Status tracking (fallback for no-interpreter) --
  let gossipActivity: GossipActivity = "inactive";
  let isSaving = false;
  let lastSaveError: string | null = null;
  const docCreatedAt = Date.now();

  // Mutable refs — updated when p2pReady resolves.
  let liveSyncManager: SyncManager | null = syncManager ?? null;
  let liveAwarenessRoom: AwarenessRoom | null = awarenessRoom ?? null;
  // Tracks whether p2pReady resolved so teardown
  // knows to release Helia (avoids ref-count
  // underflow if Helia was never acquired).
  let p2pResolved = false;
  // Channels accessed before sync was available —
  // connected when p2pReady resolves (#199).
  const accessedChannels = new Set<string>();
  // Channels already warned about missing write key —
  // avoids spamming console on repeated channel() calls.
  const warnedChannels = new Set<string>();
  // Standalone awareness: prefer awarenessRoom's if
  // available, otherwise use the standalone param.
  const awareness: Awareness = awarenessRoom?.awareness ?? params.awareness!;

  let lastStatus = computeStatus(
    liveSyncManager?.status ?? "disconnected",
    liveAwarenessRoom?.connected ?? false,
    gossipActivity,
    docCreatedAt,
  );
  let lastSaveState = computeSaveState(subdocManager.isDirty, isSaving);

  function checkStatus() {
    const next = computeStatus(
      liveSyncManager?.status ?? "disconnected",
      liveAwarenessRoom?.connected ?? false,
      gossipActivity,
      docCreatedAt,
    );
    if (next !== lastStatus) {
      lastStatus = next;
      statusFeed._update(next);
    }
  }

  // After grace period expires, re-check status so
  // it transitions from "connecting" to "offline"
  // if nothing has connected.
  const graceTimer = setTimeout(() => checkStatus(), MESH_GRACE_MS + 50);

  function checkSaveState() {
    const next = computeSaveState(
      subdocManager.isDirty,
      isSaving,
      lastSaveError,
    );
    if (next !== lastSaveState) {
      lastSaveState = next;
      saveStateFeed._update(next);
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

  // Local chain state maintained synchronously by
  // publish(). Lets history() return immediately
  // without waiting for the async interpreter
  // pipeline.
  let localChain: ChainState | null = null;

  let interpreterAc: AbortController | null = null;
  let pendingAnnounceRetry: ReturnType<typeof setTimeout> | null = null;
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
  const backedUpFeed: WritableFeed<boolean> = createFeed<boolean>(false);

  const EMPTY_VERSION_HISTORY: VersionHistory = {
    entries: [],
    walking: false,
  };
  const versionsFeed: WritableFeed<VersionHistory> = createFeed<VersionHistory>(
    EMPTY_VERSION_HISTORY,
  );

  // --- Event feeds (replace emit/listeners) ---
  // For event-like notifications, use a comparator
  // that never deduplicates so every _update fires.
  const snapshotEventFeed: WritableFeed<SnapshotEvent | null> =
    createFeed<SnapshotEvent | null>(null, () => false);
  const ackEventFeed: WritableFeed<string | null> = createFeed<string | null>(
    null,
    () => false,
  );
  const nodeChangeFeed: WritableFeed<number> = createFeed<number>(
    0,
    () => false,
  );
  const dirtyCountFeed: WritableFeed<number> = createFeed<number>(
    0,
    () => false,
  );
  const gossipActivityFeed: WritableFeed<GossipActivity> =
    createFeed<GossipActivity>("inactive");
  const persistenceErrorFeed: WritableFeed<string | null> = createFeed<
    string | null
  >(null);
  type ValidationErrorInfo = {
    cid: string;
    message: string;
  } | null;
  const validationErrorFeed: WritableFeed<ValidationErrorInfo> =
    createFeed<ValidationErrorInfo>(null);

  // --- Client identity mapping feed ---
  const clientIdMapping = createClientIdMapping(
    subdocManager.metaDoc,
    ipnsName,
  );
  const clientIdMappingFeed = clientIdMapping.feed;

  let versionCacheTimer: ReturnType<typeof setTimeout> | null = null;
  const VERSION_CACHE_DEBOUNCE_MS = 500;

  function flushVersionCache(): void {
    if (versionCacheTimer) {
      clearTimeout(versionCacheTimer);
      versionCacheTimer = null;
    }
    const { entries } = versionsFeed.getSnapshot();
    if (entries.length === 0) return;
    const cached: CachedVersionEntry[] = entries.map((e) => ({
      cid: e.cid.toString(),
      seq: e.seq,
      ts: e.ts,
    }));
    writeVersionCache(ipnsName, cached).catch((err) => {
      log.debug("version cache flush failed:", err);
    });
  }

  function scheduleVersionCacheWrite(): void {
    if (versionCacheTimer) {
      clearTimeout(versionCacheTimer);
    }
    versionCacheTimer = setTimeout(
      flushVersionCache,
      VERSION_CACHE_DEBOUNCE_MS,
    );
  }

  function updateVersionsFeed(): void {
    versionsFeed._update(
      deriveVersionHistory(interpreterState?.chain ?? null, localChain),
    );
    scheduleVersionCacheWrite();
  }

  // --- Event bridges ---
  // Status and saveState are always computed
  // locally (synchronous). The interpreter also
  // tracks them internally but the local tracking
  // is authoritative for getters and events.

  subdocManager.on("dirty", () => {
    // Clear save error on new edits — user is back
    // to "dirty" state, previous error is stale.
    lastSaveError = null;
    checkSaveState();
    dirtyCountFeed._update(dirtyCountFeed.getSnapshot() + 1);
    awareness?.setLocalStateField("clockSum", computeClockSum());
    factQueue?.push({
      type: "content-dirty",
      ts: Date.now(),
      clockSum: computeClockSum(),
    });
  });

  // Wire sync/awareness status bridges. These are
  // called immediately if deps are available, or
  // deferred until p2pReady resolves.
  function wireSyncBridges(sm: SyncManager, ar: AwarenessRoom): void {
    sm.onStatusChange(() => {
      checkStatus();
      factQueue?.push({
        type: "sync-status-changed",
        ts: Date.now(),
        status: sm.status,
      });
    });
    ar.onStatusChange(() => {
      checkStatus();
      factQueue?.push({
        type: "awareness-status-changed",
        ts: Date.now(),
        connected: ar.connected,
      });
    });
  }

  if (liveSyncManager && liveAwarenessRoom) {
    wireSyncBridges(liveSyncManager, liveAwarenessRoom);
  }

  // If the subdoc is already dirty (e.g. _meta was
  // populated before we registered), fire the event
  // so the auto-save debounce starts.
  if (subdocManager.isDirty) {
    // Defer to next microtask so callers can attach
    // event listeners first.
    queueMicrotask(() => {
      checkSaveState();
      dirtyCountFeed._update(dirtyCountFeed.getSnapshot() + 1);
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
  if (params.roomDiscovery && awareness) {
    relaySharing = createRelaySharing({
      awareness,
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
    nodeChangeFeed._update(nodeChangeFeed.getSnapshot() + 1);
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
        awareness: awareness!,
        registry,
        libp2p: helia.libp2p,
      });
      registry.on("change", nodeChangeHandler);
    }
  } catch (err) {
    log.warn("topology sharing init skipped:", (err as Error)?.message ?? err);
  }

  // ── Participant awareness (identity) ──────────
  const identityPubkeyHex = params.identity
    ? bytesToHex(params.identity.publicKey)
    : null;

  const cleanupParticipant = awareness
    ? setupParticipantAwareness(
        params.identity,
        awareness,
        subdocManager.metaDoc,
        ipnsName,
      )
    : () => {};

  // ── Interpreter setup ─────────────────────────
  let stopIPNSWatch: (() => void) | null = null;
  let initialQueryTimer: ReturnType<typeof setTimeout> | null = null;
  let guaranteeQueryInterval: ReturnType<typeof setInterval> | null = null;

  // Start the P2P + interpreter layer. Called either
  // immediately (when pubsub is provided inline) or
  // when p2pReady resolves.
  function startP2PLayer(
    pubsub: PubSubLike,
    roomDiscovery?: RoomDiscovery,
  ): void {
    if (!readKey || !params.appId) return;
    const rk = readKey;
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

    const fq = factQueue;

    // --- Hydrate version index from IDB cache ---
    readVersionCache(ipnsName)
      .then((cached) => {
        if (!cached || destroyed) return;
        for (const e of cached.entries) {
          try {
            fq.push({
              type: "cid-discovered",
              ts: e.ts,
              cid: CID.parse(e.cid),
              source: "cache",
              seq: e.seq,
              snapshotTs: e.ts,
            });
          } catch {
            // skip unparseable CIDs
          }
        }
        log.debug("hydrated " + cached.entries.length + " cached versions");
      })
      .catch((err) => {
        log.debug("version cache hydration failed:", err);
      });

    // --- GossipSub subscription + fact bridge ---
    const topic = announceTopic(appId);
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

        // Derived backedUp — true when current tip
        // has at least one pinner ack.
        backedUpFeed._update((lastTipInfo?.ackedBy.size ?? 0) > 0);

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
            !readyResolved &&
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

    // --- Effect handlers ---
    const snapshotOps = createSnapshotOps({
      snapshotCodec: snapshotLC,
      subdocManager,
      resolver,
      readKey: rk,
      getClockSum: computeClockSum,
    });

    const effects: EffectHandlers = {
      fetchBlock: async (cid) => {
        return resolver.get(cid);
      },

      getBlock: (cid) => {
        return resolver.getCached(cid);
      },

      ...snapshotOps,

      announce: (cid, block, seq) => {
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
          const topic = announceTopic(appId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const gs = pubsub as any;
          const hasMesh = () => (gs.getMeshPeers?.(topic)?.length ?? 0) > 0;

          if (!hasMesh()) {
            log.info(
              "no mesh peers for announce topic," + " scheduling retries",
            );
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
      },

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
        gossipActivity = activity;
        checkStatus();
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

      // Status and saveState are tracked locally
      // (synchronous). The interpreter's derived
      // values are redundant — local handlers
      // already fire events.
      emitStatus: () => {},
      emitSaveState: () => {},
      emitValidationError: (info) => {
        validationErrorFeed._update(info);
      },
    };

    // --- Run interpreter ---
    runInterpreter(captureState(stateStream), effects, factQueue, signal).catch(
      (err) => {
        if (!signal.aborted) {
          log.warn("interpreter error:", err);
          // Ensure ready() resolves even if the
          // interpreter crashes — otherwise the doc
          // hangs permanently with no recovery path.
          markReady();
        }
      },
    );

    // --- HTTP tip fetch (fastest path) ---
    // Fire in parallel with IPNS — whichever
    // resolves first pushes cid-discovered.
    // This is purely additive: IPNS drives loading
    // state (ipns-resolve-started/completed), so
    // HTTP failure never blocks the loading
    // lifecycle.
    if (params.performInitialResolve) {
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
          if (
            tip.guaranteeUntil !== undefined ||
            tip.retainUntil !== undefined
          ) {
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
  }

  // Start immediately if pubsub already available
  if (params.pubsub) {
    startP2PLayer(params.pubsub, params.roomDiscovery);
  }

  // Deferred P2P: wire up when Helia finishes
  if (params.p2pReady && !params.pubsub) {
    params.p2pReady
      .then((deps) => {
        if (destroyed) return;
        p2pResolved = true;
        liveSyncManager = deps.syncManager;
        liveAwarenessRoom = deps.awarenessRoom;
        wireSyncBridges(deps.syncManager, deps.awarenessRoom);
        // Connect channels accessed before P2P
        for (const ch of accessedChannels) {
          deps.syncManager.connectChannel(ch);
        }
        checkStatus();

        // Relay sharing (deferred)
        if (deps.roomDiscovery && awareness) {
          relaySharing = createRelaySharing({
            awareness,
            roomDiscovery: deps.roomDiscovery,
          });
        }

        // Topology sharing (deferred)
        try {
          const registry = getNodeRegistry();
          if (registry && awareness) {
            const helia = getHelia();
            topSharing = createTopologySharing({
              awareness,
              registry,
              libp2p: helia.libp2p,
            });
            registry.on("change", nodeChangeHandler);
          }
        } catch (err) {
          log.warn(
            "deferred topology sharing failed:",
            (err as Error)?.message ?? err,
          );
        }

        startP2PLayer(deps.pubsub, deps.roomDiscovery);
      })
      .catch((err) => {
        log.warn("p2pReady failed:", err);
        // Ensure ready() resolves even without P2P
        markReady();
      });
  }

  function teardown() {
    destroyed = true;
    clearTimeout(graceTimer);
    // Flush version cache before cleanup
    flushVersionCache();
    // Interpreter cleanup
    if (pendingAnnounceRetry !== null) {
      clearTimeout(pendingAnnounceRetry);
      pendingAnnounceRetry = null;
    }
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
    // Unsubscribe all event→Feed bridges
    for (const map of eventSubs.values()) {
      for (const unsub of map.values()) unsub();
    }
    eventSubs.clear();
    clientIdMapping.destroy();
    cleanupParticipant();
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
    liveSyncManager?.destroy();
    liveAwarenessRoom?.destroy();
    // Clean up standalone awareness + backing doc
    // when awarenessRoom never materialized (e.g.
    // p2pReady rejected or doc destroyed early).
    if (params.awareness && !liveAwarenessRoom) {
      params.awareness.destroy();
      params.awareness.doc.destroy();
    }
    subdocManager.destroy();
    // Only release Helia if p2pReady resolved (we
    // acquired it) or if inline path (no p2pReady).
    if (p2pResolved || !params.p2pReady) {
      releaseHelia();
    }
  }

  function assertNotDestroyed() {
    if (destroyed) {
      throw new DestroyedError(
        "Doc has been destroyed and can no longer" +
          " be used. Create or open a new Doc" +
          " instance instead",
      );
    }
  }

  const providerObj = {
    get awareness(): Awareness {
      return awareness!;
    },
  };

  return {
    channel(name: string): Y.Doc {
      assertNotDestroyed();
      try {
        const doc = subdocManager.subdoc(name);
        accessedChannels.add(name);
        liveSyncManager?.connectChannel(name);
        if (
          !cap.isAdmin &&
          cap.channels.size > 0 &&
          !cap.channels.has(name) &&
          !warnedChannels.has(name)
        ) {
          warnedChannels.add(name);
          log.warn(
            `Channel "${name}" accessed without` +
              " write key — sync disabled for this" +
              " channel. Ask the document admin for" +
              " a re-invite that includes this" +
              " channel.",
          );
        }
        return doc;
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
      return awareness!;
    },

    get capability(): Capability {
      return cap;
    },

    get configuredChannels(): readonly string[] {
      return [...channels];
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
            throw new PermissionError(
              `Cannot grant "${ch}" ` + "— not in own capability",
            );
          }
        }
      }
      if (grant.canPushSnapshots && !cap.canPushSnapshots) {
        throw new PermissionError(
          "Cannot grant canPushSnapshots " + "— not in own capability",
        );
      }
      const narrowed = narrowCapability(keys, grant);
      return buildUrl(origin, ipnsName, narrowed);
    },

    status: statusFeed as Feed<DocStatus>,
    saveState: saveStateFeed as Feed<SaveState>,

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

    get loadingState(): LoadingState {
      return loadingFeed.getSnapshot();
    },

    tip: tipFeed as Feed<VersionInfo | null>,
    loading: loadingFeed as Feed<LoadingState>,
    backedUp: backedUpFeed as Feed<boolean>,
    versions: versionsFeed as Feed<VersionHistory>,
    snapshotEvents: snapshotEventFeed as Feed<SnapshotEvent | null>,
    gossipActivity: gossipActivityFeed as Feed<GossipActivity>,
    clientIdMapping: clientIdMappingFeed as Feed<IdentityMap>,
    lastPersistenceError: persistenceErrorFeed as Feed<string | null>,
    lastValidationError: validationErrorFeed as Feed<ValidationErrorInfo>,

    ready(options?: { timeoutMs?: number }): Promise<void> {
      if (!options?.timeoutMs) return readyPromise;
      return Promise.race([
        readyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new TimeoutError(
                  "ready() timed out after " +
                    `${options.timeoutMs}ms` +
                    " — the document did not finish" +
                    " initial sync in time. Check" +
                    " network connectivity or" +
                    " increase the timeout",
                ),
              ),
            options.timeoutMs,
          ),
        ),
      ]);
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
      const clockSum = computeClockSum();
      let pushResult;
      try {
        pushResult = await snapshotLC.push(
          plaintext,
          readKey,
          signingKey,
          clockSum,
          params.identity,
        );
      } catch (err) {
        isSaving = false;
        lastSaveError = err instanceof Error ? err.message : String(err);
        checkSaveState();
        factQueue?.push({
          type: "publish-failed",
          ts: Date.now(),
          error: lastSaveError,
        });
        throw err;
      }
      const { cid, block } = pushResult;

      // Store block via resolver (memory + IDB)
      resolver.put(cid, block);

      // Suppress the interpreter's
      // emitSnapshotApplied for this CID since
      // we emit the local snapshot event below.
      lastLocalPublishCid = cid.toString();

      isSaving = false;
      lastSaveError = null;
      checkSaveState();

      // Build the facts that describe this publish.
      const now = Date.now();
      const cidDiscovered: Fact = {
        type: "cid-discovered",
        ts: now,
        cid,
        source: "gossipsub",
        block,
        seq: pushResult.seq,
        snapshotTs: now,
      };
      const blockFetched: Fact = {
        type: "block-fetched",
        ts: now,
        cid,
        block,
        prev: pushResult.prev ?? undefined,
        seq: pushResult.seq,
        snapshotTs: now,
      };
      const tipAdvanced: Fact = {
        type: "tip-advanced",
        ts: now,
        cid,
        seq: pushResult.seq,
      };
      const publishSucceeded: Fact = {
        type: "publish-succeeded",
        ts: now,
        cid,
        seq: pushResult.seq,
      };

      // Synchronously advance localChain so the
      // versions Feed updates without waiting for
      // the async interpreter pipeline.
      const base =
        localChain ??
        interpreterState?.chain ??
        initialDocState({
          ipnsName,
          role: this.role,
          channels,
          appId: params.appId,
        }).chain;
      localChain = [
        cidDiscovered,
        blockFetched,
        tipAdvanced,
        publishSucceeded,
      ].reduce(reduceChain, base);

      // Update versions feed synchronously so
      // subscribers see the new version immediately.
      updateVersionsFeed();

      // Push to interpreter for side effects
      // (announce, acks, gossip, etc.)
      if (factQueue) {
        factQueue.push(cidDiscovered);
        factQueue.push(blockFetched);
        factQueue.push(tipAdvanced);
        factQueue.push(publishSucceeded);
      }

      snapshotEventFeed._update({
        cid,
        seq: pushResult.seq,
        ts: Date.now(),
        isLocal: true,
      });

      // Publish IPNS — fire-and-forget. Block is
      // already persisted via resolver.put() above.
      // Announce is handled by the interpreter via
      // the publish-succeeded fact.
      const cidShort = cid.toString().slice(0, 16);
      log.info("publish: cid=" + cidShort + "... clockSum=" + clockSum);
      (async () => {
        const helia = getHelia();
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
      if (!eventSubs.has(event)) {
        eventSubs.set(event, new Map());
      }
      const map = eventSubs.get(event)!;
      // Already subscribed with this callback
      if (map.has(cb)) return;

      let unsub: () => void;
      switch (event) {
        case "status":
          unsub = statusFeed.subscribe(() => cb(statusFeed.getSnapshot()));
          break;
        case "save":
          unsub = saveStateFeed.subscribe(() =>
            cb(saveStateFeed.getSnapshot()),
          );
          break;
        case "loading":
          unsub = loadingFeed.subscribe(() => cb(loadingFeed.getSnapshot()));
          break;
        case "snapshot":
          unsub = snapshotEventFeed.subscribe(() => {
            const v = snapshotEventFeed.getSnapshot();
            if (v) cb(v);
          });
          break;
        case "ack":
          unsub = ackEventFeed.subscribe(() => {
            const v = ackEventFeed.getSnapshot();
            if (v) cb(v);
          });
          break;
        case "node-change":
          unsub = nodeChangeFeed.subscribe(() => cb());
          break;
        case "publish-needed":
          unsub = dirtyCountFeed.subscribe(() => cb());
          break;
        case "gossip-activity":
          unsub = gossipActivityFeed.subscribe(() =>
            cb(gossipActivityFeed.getSnapshot()),
          );
          break;
        default:
          return;
      }
      map.set(cb, unsub);
    },

    off(event: string, cb: (...args: any[]) => void) {
      const unsub = eventSubs.get(event)?.get(cb);
      if (unsub) {
        unsub();
        eventSubs.get(event)!.delete(cb);
      }
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
        latestAnnouncedSeq: interpreterState?.chain.maxSeq ?? 0,
        loadingState: loadingFeed.getSnapshot(),
        hasAppliedSnapshot:
          interpreterState?.chain.tip !== null &&
          interpreterState?.chain.tip !== undefined,
        guaranteeUntil: g.guaranteeUntil || null,
        retainUntil: g.retainUntil || null,
        roomDiscovery: params.roomDiscovery,
        awareness: awareness!,
        clockSum: computeClockSum(),
        ipnsSeq: snapshotLC.lastIpnsSeq,
      });
    },

    topologyGraph(): TopologyGraph {
      assertNotDestroyed();
      return buildTopologyGraph(this.diagnostics(), awareness!);
    },

    async versionHistory(): Promise<VersionEntry[]> {
      assertNotDestroyed();
      const chainFallback = async () => {
        const { entries } = versionsFeed.getSnapshot();
        return entries.map((e) => ({
          cid: e.cid,
          seq: e.seq,
          ts: e.ts,
        }));
      };
      const entries = await fetchVersionHistory(
        getHttpUrls(),
        ipnsName,
        chainFallback,
      );
      // Integrate pinner-discovered CIDs into
      // chain state so future calls use state.
      if (factQueue) {
        for (const e of entries) {
          const key = e.cid.toString();
          if (!interpreterState?.chain.entries.has(key)) {
            factQueue.push({
              type: "cid-discovered",
              ts: Date.now(),
              cid: e.cid,
              source: "pinner-index",
              seq: e.seq,
              snapshotTs: e.ts,
            });
          }
        }
      }
      return entries;
    },

    async loadVersion(cid: CID) {
      assertNotDestroyed();
      if (!readKey) {
        throw new PermissionError(
          "loadVersion() requires read capability" +
            " — the current URL does not include" +
            " a readKey. Use an admin or read URL" +
            " to access version history",
        );
      }
      const result = await snapshotLC.loadVersion(cid, readKey);
      // Integrate fetched block into chain state
      // so the reducer knows about it.
      if (factQueue) {
        const key = cid.toString();
        const entry = interpreterState?.chain.entries.get(key);
        if (!entry || entry.blockStatus === "unknown") {
          const block = resolver.getCached(cid);
          factQueue.push({
            type: "cid-discovered",
            ts: Date.now(),
            cid,
            source: "chain-walk",
            block: block ?? undefined,
          });
        }
      }
      return result;
    },

    get identityPubkey(): string | null {
      return identityPubkeyHex;
    },

    authorize(pubkey: string): void {
      assertNotDestroyed();
      if (!cap.isAdmin) {
        throw new PermissionError(
          "authorize() requires admin capability" +
            " — only the document creator can" +
            " manage authorized publishers",
        );
      }
      const map = subdocManager.metaDoc.getMap<true>("authorizedPublishers");
      map.set(pubkey, true);
    },

    deauthorize(pubkey: string): void {
      assertNotDestroyed();
      if (!cap.isAdmin) {
        throw new PermissionError(
          "deauthorize() requires admin capability" +
            " — only the document creator can" +
            " manage authorized publishers",
        );
      }
      const map = subdocManager.metaDoc.getMap<true>("authorizedPublishers");
      map.delete(pubkey);
    },

    get authorizedPublishers(): ReadonlySet<string> {
      const map = subdocManager.metaDoc.getMap<true>("authorizedPublishers");
      const result = new Set<string>();
      for (const key of map.keys()) {
        result.add(key);
      }
      return result;
    },

    get participants(): ReadonlyMap<number, ParticipantInfo> {
      const result = new Map<number, ParticipantInfo>();
      const states = awareness!.getStates();
      for (const [clientId, state] of states) {
        const p = state.participant as ParticipantAwareness | undefined;
        if (!p?.pubkey || !p?.sig) continue;
        // Verify sig: covers (pubkey + ":" + docId)
        result.set(clientId, {
          pubkey: p.pubkey,
          displayName: p.displayName,
        });
      }
      return result;
    },

    destroy(): void {
      if (destroyed) return;
      teardown();
    },
  } as Doc;
}
