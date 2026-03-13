import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import { narrowCapability, buildUrl } from "@pokapali/capability";
import { hexToBytes, bytesToHex, verifySignature } from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { signParticipant } from "./identity.js";
import type { ParticipantAwareness } from "./identity.js";
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
  SyncStatus,
  LoadingState,
  GossipActivity,
  VersionHistory,
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
  /** Error message from the last failed save,
   *  or null. Cleared on next edit or successful
   *  save. Present when saveState is "save-error". */
  readonly lastSaveError: string | null;
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
  /** Reactive version history feed. Updates as
   *  chain walks discover and fetch entries. */
  readonly versions: Feed<VersionHistory>;
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
  /** @deprecated Use `doc.versions` Feed or
   *  `versionHistory()` instead. */
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
  /** This device's identity public key (hex). */
  readonly identityPubkey: string | null;
  /** Authorize a publisher by identity pubkey (hex).
   *  Requires admin capability. Adds to
   *  authorizedPublishers Y.Map in _meta. */
  authorize(pubkey: string): void;
  /** Deauthorize a publisher by identity pubkey.
   *  Requires admin capability. */
  deauthorize(pubkey: string): void;
  /** Current authorized publishers (hex pubkeys).
   *  Empty set = permissionless (anyone can publish).
   */
  readonly authorizedPublishers: ReadonlySet<string>;
  /** Participants currently visible via awareness. */
  readonly participants: ReadonlyMap<number, ParticipantInfo>;
  /** Persistent clientID→pubkey mapping from _meta.
   *  Updates reactively as peers register. Used by
   *  comments attribution and edit blame. */
  readonly clientIdMapping: Feed<ReadonlyMap<number, ClientIdentityInfo>>;
  destroy(): void;
}

export interface ParticipantInfo {
  pubkey: string;
  displayName?: string;
}

export interface ClientIdentityInfo {
  pubkey: string;
  verified: boolean;
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
  /** Device identity keypair (always present). Used
   *  for publisher attribution and participant
   *  awareness. */
  identity?: Ed25519KeyPair;
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

function computeSaveState(
  isDirty: boolean,
  isSaving: boolean,
  lastSaveError?: string | null,
): SaveState {
  if (isSaving) return "saving";
  if (lastSaveError) return "save-error";
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
  });
  const snapshotLC = createSnapshotCodec({
    resolver,
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
  let lastSaveError: string | null = null;

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
    const next = computeSaveState(
      subdocManager.isDirty,
      isSaving,
      lastSaveError,
    );
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

  // Local chain state maintained synchronously by
  // publish(). Lets history() return immediately
  // without waiting for the async interpreter
  // pipeline.
  let localChain: ChainState | null = null;

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

  const EMPTY_VERSION_HISTORY: VersionHistory = {
    entries: [],
    walking: false,
  };
  const versionsFeed: WritableFeed<VersionHistory> = createFeed<VersionHistory>(
    EMPTY_VERSION_HISTORY,
  );

  // --- Client identity mapping feed ---
  // Observes _meta "clientIdentities" Y.Map and
  // projects into a reactive Feed with async sig
  // verification.
  type IdentityMap = ReadonlyMap<number, ClientIdentityInfo>;
  const EMPTY_IDENTITY_MAP: IdentityMap = new Map();
  const clientIdMappingFeed: WritableFeed<IdentityMap> =
    createFeed<IdentityMap>(EMPTY_IDENTITY_MAP);

  // Cache verified results to avoid re-verifying
  // on every Y.Map change.
  const verifiedCache = new Map<string, boolean | null>();

  function rebuildClientIdMapping(): void {
    const identities = subdocManager.metaDoc.getMap("clientIdentities");
    const result = new Map<number, ClientIdentityInfo>();
    let pendingVerifications = 0;

    for (const [key, value] of identities.entries()) {
      const clientId = Number(key);
      if (Number.isNaN(clientId)) continue;
      const entry = value as {
        pubkey?: string;
        sig?: string;
      };
      if (!entry?.pubkey || !entry?.sig) continue;

      const cached = verifiedCache.get(key);
      if (cached !== undefined && cached !== null) {
        result.set(clientId, {
          pubkey: entry.pubkey,
          verified: cached,
        });
      } else {
        // Optimistic: show as unverified until
        // async verification completes.
        result.set(clientId, {
          pubkey: entry.pubkey,
          verified: false,
        });
        if (cached === undefined) {
          // null = in-flight
          verifiedCache.set(key, null);
          pendingVerifications++;
          const payload = new TextEncoder().encode(
            entry.pubkey + ":" + ipnsName,
          );
          verifySignature(
            hexToBytes(entry.pubkey),
            hexToBytes(entry.sig),
            payload,
          )
            .then((ok) => {
              verifiedCache.set(key, ok);
              rebuildClientIdMapping();
            })
            .catch(() => {
              verifiedCache.set(key, false);
              rebuildClientIdMapping();
            });
        }
      }
    }

    clientIdMappingFeed._update(result);
  }

  // Observe _meta clientIdentities for changes.
  const identitiesMap = subdocManager.metaDoc.getMap("clientIdentities");
  identitiesMap.observe(rebuildClientIdMapping);
  // Initial projection (may already have entries
  // from IDB-persisted _meta).
  rebuildClientIdMapping();

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

  // ── Participant awareness (identity) ──────────
  // Publish once on doc open — identity doesn't
  // change during a session.
  const identityPubkeyHex = params.identity
    ? bytesToHex(params.identity.publicKey)
    : null;

  if (params.identity) {
    const kp = params.identity;
    signParticipant(kp, ipnsName)
      .then((sig) => {
        const participant: ParticipantAwareness = {
          pubkey: bytesToHex(kp.publicKey),
          sig,
        };
        awarenessRoom.awareness.setLocalStateField("participant", participant);

        // Persist clientID→pubkey in _meta so the
        // mapping survives across snapshots. Used by
        // comments attribution and edit blame (#73).
        const clientId = awarenessRoom.awareness.clientID;
        const identities = subdocManager.metaDoc.getMap("clientIdentities");
        identities.set(String(clientId), {
          pubkey: bytesToHex(kp.publicKey),
          sig,
        });
      })
      .catch((err) => {
        log.warn(
          "participant awareness failed:",
          (err as Error)?.message ?? err,
        );
      });
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

      // CID discovery FIRST — the chain entry must
      // exist before ack/guarantee facts reference it.
      let cid: CID | undefined;
      try {
        cid = CID.parse(ann.cid);
        let block: Uint8Array | undefined;
        if (ann.block) {
          try {
            block = base64ToUint8(ann.block);
            resolver.put(cid, block);
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

      // Ack/guarantee facts AFTER discovery so the
      // reducer's updateEntry finds the chain entry.
      if (ann.ack && cid) {
        fq.push({
          type: "ack-received",
          ts: Date.now(),
          cid,
          peerId: ann.ack.peerId,
        });
        if (
          ann.ack.guaranteeUntil !== undefined ||
          ann.ack.retainUntil !== undefined
        ) {
          fq.push({
            type: "guarantee-received",
            ts: Date.now(),
            peerId: ann.ack.peerId,
            cid,
            guaranteeUntil: ann.ack.guaranteeUntil ?? 0,
            retainUntil: ann.ack.retainUntil ?? 0,
          });
        }
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

        // Version history feed — update when chain
        // changes (structural sharing: cheap check)
        if (item.next.chain !== item.prev.chain) {
          updateVersionsFeed();
        }

        yield item;
      }
    }

    // --- Effect handlers ---
    const effects: EffectHandlers = {
      fetchBlock: async (cid) => {
        return resolver.get(cid);
      },

      getBlock: (cid) => {
        return resolver.getCached(cid);
      },

      applySnapshot: async (cid, block) => {
        resolver.put(cid, block);

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
          // Extract publisher hex if present.
          // publisher field added by protocol branch
          // — cast to access it before merge.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pubBytes = (node as any).publisher as Uint8Array | undefined;
          const publisher = pubBytes ? bytesToHex(pubBytes) : undefined;
          return {
            prev: node.prev ?? undefined,
            seq: node.seq,
            snapshotTs: node.ts,
            publisher,
          };
        } catch {
          return {};
        }
      },

      isPublisherAuthorized: (publisherHex) => {
        const map = subdocManager.metaDoc.getMap<true>("authorizedPublishers");
        // Permissionless: no authorized publishers
        // configured → accept everyone.
        if (map.size === 0) return true;
        // Auth enabled: publisher must be listed.
        if (!publisherHex) return false;
        return map.has(publisherHex);
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
    // Flush version cache before cleanup
    flushVersionCache();
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
    identitiesMap.unobserve(rebuildClientIdMapping);
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

    get lastSaveError(): string | null {
      return lastSaveError;
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
    versions: versionsFeed as Feed<VersionHistory>,
    clientIdMapping: clientIdMappingFeed as Feed<IdentityMap>,

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

      // Synchronously advance localChain so
      // history() works without waiting for the
      // async interpreter pipeline.
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

      emit("snapshot", {
        cid,
        seq: pushResult.seq,
        ts: Date.now(),
        isLocal: true,
      } satisfies SnapshotEvent);

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

    /** @deprecated Use `doc.versions` Feed or
     *  `versionHistory()` instead. */
    async history() {
      assertNotDestroyed();
      const { entries } = versionsFeed.getSnapshot();
      return entries.map((e) => ({
        cid: e.cid,
        seq: e.seq,
        ts: e.ts,
      }));
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
        throw new Error("No readKey available");
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
        throw new Error("authorize() requires admin capability");
      }
      const map = subdocManager.metaDoc.getMap<true>("authorizedPublishers");
      map.set(pubkey, true);
    },

    deauthorize(pubkey: string): void {
      assertNotDestroyed();
      if (!cap.isAdmin) {
        throw new Error("deauthorize() requires admin" + " capability");
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
      const states = awarenessRoom.awareness.getStates();
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
