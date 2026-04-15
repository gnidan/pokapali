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
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import { createPeerSync } from "./peer-sync.js";
import type { PeerSync } from "./peer-sync.js";
import { createSnapshotOps } from "./snapshot-ops.js";
import { createEffectHandlers } from "./effect-handlers.js";
import { CID } from "multiformats/cid";
import { getHelia, releaseHelia } from "./helia.js";
import { publishIPNS, resolveIPNS, watchIPNS } from "./ipns-helpers.js";
import { announceTopic, publishGuaranteeQuery } from "./announce.js";
import { createGossipHandler } from "./doc-gossip-bridge.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import { createBlockResolver } from "./block-resolver.js";
import { createSnapshotCodec } from "./snapshot-codec.js";
import type { Store } from "@pokapali/store";
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
import {
  type Document,
  Edit,
  State,
  Cache,
  foldTree,
  epochMeasured,
} from "@pokapali/document";
import { measureTree } from "@pokapali/finger-tree";
import type { Codec, CodecSurface } from "@pokapali/codec";
import { DestroyedError, PermissionError, TimeoutError } from "./errors.js";
import { fetchVersionHistory } from "./fetch-version-history.js";
import type { VersionEntry } from "./fetch-version-history.js";
import { createAsyncQueue, scan, merge } from "./async-utils.js";
import type { AsyncQueue } from "./async-utils.js";
import type { Feed } from "./feed.js";
import { createDocFeeds } from "./doc-feeds.js";
import type { ValidationErrorInfo } from "./doc-feeds.js";
import { createEditBridge } from "./edit-bridge.js";
import { reannounceFacts } from "./fact-sources.js";
import {
  reduce,
  reduceChain,
  reduceSnapshotHistory,
  deriveSaveState,
} from "./reducers.js";
import {
  initialDocState,
  bestGuarantee,
  deriveVersionHistoryFromSnapshots,
  INITIAL_SNAPSHOT_HISTORY,
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
  SnapshotHistory,
} from "./facts.js";
import { runInterpreter } from "./interpreter.js";
import {
  deriveStatus,
  deriveLoadingState,
  loadingStateChanged,
} from "./doc-status.js";

const log = createLogger("core");

/**
 * Origin used when replaying edits from Store on
 * startup. Non-null so the Y.Doc editHandler skips
 * re-persisting replayed edits.
 */

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
  /**
   * Get or create a CodecSurface for a channel.
   *
   * Returns the opaque CodecSurface. Use `.handle`
   * when binding to an editor (e.g. TipTap
   * Collaboration). Edits flow through the epoch
   * tree automatically.
   */
  channel(name: string): CodecSurface;
  /**
   * Get or create a CodecSurface for a channel.
   *
   * Like channel() but requires a Document to have
   * been provided at creation time — throws
   * otherwise. Ensures the surface is bridged for
   * reconciliation.
   */
  surface(name: string): CodecSurface;
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

  // ── Identity ────────────────────────────────
  /** This device's identity public key (hex). */
  readonly identityPubkey: string | null;
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

/** A peer currently visible via awareness. */
export interface ParticipantInfo {
  /** The participant's Ed25519 identity public key
   *  (hex-encoded). */
  pubkey: string;
  /** Optional display name from awareness state. */
  displayName?: string;
}

/**
 * A registered client identity from the `_meta`
 * subdocument. Maps a Yjs clientID to a public key.
 */
export interface ClientIdentityInfo {
  /** Ed25519 public key (hex-encoded). */
  pubkey: string;
  /** True if the signature was verified. */
  verified: boolean;
}

/** P2P dependencies resolved after Helia bootstrap. */
export interface P2PDeps {
  pubsub: PubSubLike;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  roomDiscovery: RoomDiscovery;
  /** Request re-establishment of signaling with any
   *  available relay. Used when the MultiRelayRoom
   *  fires onNeedsSwap (all relays dead). */
  requestReconnect?(): void;
  /** Close the IDB blockstore on teardown. */
  closeBlockstore?: () => Promise<void>;
}

export interface DocParams {
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
  networkId: string;
  primaryChannel: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  roomDiscovery?: RoomDiscovery;
  performInitialResolve?: boolean;
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
  /** How many parent blocks to prefetch after
   *  tip-advanced. Default 3, set 0 to disable. */
  prefetchDepth?: number;
  /** Codec used for epoch-tree fold and clock-sum
   *  computation during publish(). */
  codec: Codec;
  /** Optional Document from @pokapali/document for
   *  lifecycle bridge. Stored in docDocuments WeakMap
   *  and destroyed on teardown. */
  document?: Document;
  /** Per-document Store handle for edit/snapshot
   *  persistence. */
  storeDocument?: Store.Document;
}

// Pure status derivation functions extracted to
// doc-status.ts (computeStatus, computeSaveState,
// deriveLoadingState, loadingStateChanged).

/**
 * WeakMap from Doc → Document (from @pokapali/document).
 * Populated by createDoc when a Document is provided.
 * Used by App to access the lifecycle container for
 * each managed Doc without a public API change.
 */
export const docDocuments = new WeakMap<Doc, Document>();

export function createDoc(params: DocParams): Doc {
  const {
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

  // _meta surface — comes from the Document surface
  // just like any other channel. Used for client
  // identity mapping and title.
  const metaSurface = params.document?.hasSurface("_meta")
    ? params.document.surface("_meta")
    : params.codec.createSurface({
        guid: `${ipnsName}:_meta`,
      });

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

  // Replay persisted edits from Store into surfaces.
  // Old y-indexeddb data is migrated into Store at
  // Store.create time (store/migrate.ts), so this is
  // the only hydration path. Uses applyEdit() so
  // replayed edits are treated as remote (not
  // re-persisted by the edit bridge). Calls
  // markReady() after replay completes so the editor
  // is usable while IPNS resolution continues in
  // background.
  if (params.storeDocument && params.document) {
    const doc = params.document;
    const storeDoc = params.storeDocument;
    const replayPromises: Promise<void>[] = [];
    for (const ch of channels) {
      if (!doc.hasSurface(ch)) continue;
      const surface = doc.surface(ch);
      const p = storeDoc
        .history(ch)
        .load()
        .then((epochs) => {
          let count = 0;
          for (const epoch of epochs) {
            for (const edit of epoch.edits) {
              surface.applyEdit(edit.payload);
              count++;
            }
          }
          if (count > 0) {
            log.info(`replayed ${count} edits for ${ch}`);
          }
        })
        .catch((err) => {
          log.warn("store edit replay failed:", err);
        });
      replayPromises.push(p);
    }
    Promise.all(replayPromises)
      .then(() => markReady())
      .catch(() => markReady());
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
  let closeBlockstore: (() => Promise<void>) | null = null;
  // Channels already warned about missing write key —
  // avoids spamming console on repeated channel() calls.
  const warnedChannels = new Set<string>();
  // Peer sync is created lazily (after persistEdit
  // is defined) — declare the variable here so
  // unsubPeerConn and wireSyncBridges can reference it.
  let peerSync: PeerSync | null = null;

  let unsubPeerConn: (() => void) | null = null;
  // Standalone awareness: prefer awarenessRoom's if
  // available, otherwise use the standalone param.
  const awareness: Awareness = awarenessRoom?.awareness ?? params.awareness!;

  // Local dirty flag — replaces subdocManager.isDirty.
  // Set when any surface or subdoc Y.Doc receives a
  // local edit; cleared after publish() snapshots.
  let contentDirty = false;

  function markContentDirty(): void {
    if (contentDirty) return;
    contentDirty = true;
    // Clear save error on new edits — user is back
    // to "dirty" state, previous error is stale.
    lastSaveError = null;
    syncSaveState();
    dirtyCountFeed._update(dirtyCountFeed.getSnapshot() + 1);
    awareness?.setLocalStateField("clockSum", computeClockSum());
    factQueue?.push({
      type: "content-dirty",
      ts: Date.now(),
      clockSum: computeClockSum(),
    });
  }

  function computeClockSum(): number {
    if (!params.document) return 0;
    let sum = 0;
    for (const ns of channels) {
      if (!params.document.hasSurface(ns)) continue;
      const sv = params.document.surface(ns).encodeStateVector();
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

  // Mirror of localChain for the snapshot-based
  // version history path.
  let localSnapshotHistory: SnapshotHistory | null = null;

  let interpreterAc: AbortController | null = null;
  // Effect handler state (announce retries, dedup)
  // is managed inside createEffectHandlers().
  let effectHandlersCleanup: (() => void) | null = null;
  let setLastLocalPublishCid: ((cid: string) => void) | null = null;
  // --- Feeds ---
  const {
    docStateFeed,
    statusFeed,
    saveStateFeed,
    tipFeed,
    loadingFeed,
    backedUpFeed,
    versionsFeed,
    snapshotEventFeed,
    ackEventFeed,
    nodeChangeFeed,
    dirtyCountFeed,
    gossipActivityFeed,
    persistenceErrorFeed,
    validationErrorFeed,
    graceTimer,
  } = createDocFeeds({
    ipnsName,
    role: cap.isAdmin ? "admin" : cap.channels.size > 0 ? "writer" : "reader",
    channels,
    appId: params.appId ?? "",
    createdAt: docCreatedAt,
  });

  // Synchronous local-state push: updates
  // docStateFeed immediately when local vars
  // (isSaving, isDirty, etc.) change, so
  // projectFeed projections respond without
  // waiting for the async interpreter pipeline.
  // The interpreter eventually converges to the
  // same state when facts are processed.
  function syncSaveState() {
    const current = docStateFeed.getSnapshot();
    const nextContent = {
      ...current.content,
      isDirty: contentDirty,
      isSaving,
      lastSaveError,
    };
    // Use localChain when available — it's updated
    // synchronously by publish() before the async
    // interpreter pipeline processes the facts.
    const chain = localChain ?? current.chain;
    const next = deriveSaveState(nextContent, chain);
    if (next !== current.saveState) {
      docStateFeed._update({
        ...current,
        content: nextContent,
        saveState: next,
      });
    }
  }

  let lastTipInfo: VersionInfo | null = null;

  // --- Client identity mapping feed ---
  const clientIdMapping = createClientIdMapping(metaSurface, ipnsName);
  const clientIdMappingFeed = clientIdMapping.feed;

  // Persist snapshot metadata to Store (fire-and-forget,
  // idempotent via put-based upsert).
  const storeSnapshots = params.storeDocument?.snapshots;
  function persistSnapshot(cid: CID, seq: number, ts: number): void {
    storeSnapshots
      ?.append({
        cid: cid.bytes,
        seq,
        ts,
        // TODO: placeholders until snapshot metadata
        // includes channel/epoch provenance
        channel: "",
        epochIndex: 0,
      })
      .catch((err) => {
        log.warn("snapshot persist failed:", err);
      });
  }

  // Persist edits to Store (fire-and-forget).
  // Computes tip epoch index from the channel's tree.
  const storeDocument = params.storeDocument;
  function persistEdit(channelName: string, edit: Edit): void {
    if (!storeDocument || !params.document) return;
    const ch = params.document.channel(channelName);
    const summary = measureTree(epochMeasured, ch.tree);
    const tipIndex = summary.epochCount - 1;
    storeDocument
      .history(channelName)
      .append(tipIndex, edit)
      .catch((err) => {
        log.warn("edit persist failed:", err);
      });
  }

  // Peer sync: reconciliation wirings + live edit
  // forwarding across WebRTC data channels.
  if (params.document) {
    peerSync = createPeerSync({
      channels,
      document: params.document,
      codec: params.codec,
      identity: params.identity,
      persistEdit,
      onSyncStatusChanged: (status) => {
        factQueue?.push({
          type: "sync-status-changed",
          ts: Date.now(),
          status,
        });
      },
    });
  }

  function updateVersionsFeed(): void {
    const prev = versionsFeed.getSnapshot();
    const next = deriveVersionHistoryFromSnapshots(
      localSnapshotHistory ??
        interpreterState?.snapshotHistory ??
        INITIAL_SNAPSHOT_HISTORY,
    );
    versionsFeed._update(next);

    // Persist any newly discovered entries
    const prevCids = new Set(prev.entries.map((e) => e.cid.toString()));
    for (const e of next.entries) {
      if (!prevCids.has(e.cid.toString())) {
        persistSnapshot(e.cid, e.seq, e.ts);
      }
    }
  }

  // Hex-encoded identity pubkey (derived once, used
  // in edit bridge + participant awareness).
  const identityPubkeyHex = params.identity
    ? bytesToHex(params.identity.publicKey)
    : null;

  // --- Event bridges ---
  // Status and saveState are always computed
  // locally (synchronous). The interpreter also
  // tracks them internally but the local tracking
  // is authoritative for getters and events.

  // Bridge Y.Doc updates → epoch tree so the
  // reconciliation protocol has edits to send.
  // Skips snapshot-apply and Store-replay origins.
  //
  // The bridge registers on surface Y.Docs (returned
  // by doc.channel()). Local edits (null origin) are
  // routed through channel.appendEdit +
  // scheduleReconcile. The surface's onLocalEdit in
  // Document also fires (async, signed) — the
  // duplicate is harmless because codec merge is
  // idempotent.
  const editBridge = createEditBridge({
    channels,
    document: params.document,
    codec: params.codec,
    identityPubkeyHex,
    ipnsName,
    persistEdit,
    scheduleReconcile: () => peerSync?.scheduleReconcile(),
    markContentDirty,
  });
  const { surfaceBridged, fallbackSurfaces } = editBridge;

  // Wire sync/awareness status bridges. These are
  // called immediately if deps are available, or
  // deferred until p2pReady resolves.
  function wireSyncBridges(_sm: SyncManager, ar: AwarenessRoom): void {
    // Sync status facts are now emitted by
    // peerSync.onSyncStatusChanged, not by
    // SyncManager.onStatusChange.
    ar.onStatusChange(() => {
      factQueue?.push({
        type: "awareness-status-changed",
        ts: Date.now(),
        connected: ar.connected,
      });
    });

    // Reconciliation: create data channels BEFORE
    // the SDP offer (via onPeerCreated) so they're
    // included in ICE negotiation. This also ensures
    // the callback is registered before the room
    // discovers any peers — critical for the upgrade
    // path where the room may already be joining.
    if (!ar.onPeerCreated || !peerSync) return;
    unsubPeerConn?.();
    unsubPeerConn = ar.onPeerCreated((pc, initiator) => {
      if (destroyed) return;
      peerSync?.wirePeerConnection(pc, initiator);
    });
  }

  if (liveSyncManager && liveAwarenessRoom) {
    wireSyncBridges(liveSyncManager, liveAwarenessRoom);
  }

  // metaSurface was populated before we registered our
  // update handler, so fire dirty on next microtask
  // to start the auto-save debounce.
  queueMicrotask(() => {
    markContentDirty();
  });

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
  const cleanupParticipant = awareness
    ? setupParticipantAwareness(
        params.identity,
        awareness,
        metaSurface,
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
    // Carry createdAt for mesh grace period
    init.connectivity = {
      ...init.connectivity,
      createdAt: docCreatedAt,
    };
    init.status = deriveStatus(init.connectivity);
    interpreterState = init;
    docStateFeed._update(init);

    const fq = factQueue;

    // --- Hydrate version index from Store ---
    if (storeSnapshots) {
      storeSnapshots
        .loadAll()
        .then((cached) => {
          if (destroyed) return;
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
              localSnapshotHistory = reduceSnapshotHistory(
                localSnapshotHistory ??
                  interpreterState?.snapshotHistory ??
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
    const topic = announceTopic(params.networkId, appId);
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
      document: params.document,
      resolver,
      readKey: rk,
      getClockSum: computeClockSum,
    });

    const effectHandlers = createEffectHandlers({
      resolver,
      snapshotOps,
      pubsub,
      networkId: params.networkId,
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
      onGossipActivity: (activity) => {
        gossipActivity = activity;
      },
    });
    const { effects } = effectHandlers;
    effectHandlersCleanup = effectHandlers.cleanup;
    setLastLocalPublishCid = effectHandlers.setLastLocalPublishCid;

    // --- Run interpreter ---
    runInterpreter(captureState(stateStream), effects, factQueue, signal, {
      prefetchDepth: params.prefetchDepth,
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
      publishGuaranteeQuery(pubsub, params.networkId, appId, ipnsName).catch(
        (err) => {
          log.warn("guarantee query failed:", err);
        },
      );
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
        if (destroyed) {
          deps.closeBlockstore?.();
          return;
        }
        p2pResolved = true;
        closeBlockstore = deps.closeBlockstore ?? null;
        liveSyncManager = deps.syncManager;
        liveAwarenessRoom = deps.awarenessRoom;
        wireSyncBridges(deps.syncManager, deps.awarenessRoom);

        // Wire onNeedsSwap on the MultiRelayRoom so
        // that when ALL relays are dead (signaling
        // closed + no WebRTC peers), we proactively
        // re-establish signaling.
        deps.awarenessRoom.onNeedsSwap(() => {
          if (destroyed) return;
          log.info("all relays dead — requesting" + " reconnect");
          deps.requestReconnect?.();
        });

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
    // Interpreter cleanup
    effectHandlersCleanup?.();
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
    // Tear down edit bridge
    editBridge.destroy();
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
    // Tear down peer sync (reconciliation + live edits)
    unsubPeerConn?.();
    peerSync?.destroy();
    liveSyncManager?.destroy();
    liveAwarenessRoom?.destroy();
    // Clean up standalone awareness + backing doc
    // when awarenessRoom never materialized (e.g.
    // p2pReady rejected or doc destroyed early).
    if (params.awareness && !liveAwarenessRoom) {
      params.awareness.destroy();
      params.awareness.doc.destroy();
    }
    // Destroy bridged Document if present
    params.document?.destroy();
    // Only release Helia if p2pReady resolved (we
    // acquired it) or if inline path (no p2pReady).
    if (p2pResolved || !params.p2pReady) {
      releaseHelia();
    }
    // Close IDB blockstore after Helia releases it.
    closeBlockstore?.();
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

  const ensureSurfaceBridged = editBridge.ensureSurfaceBridged;

  const doc = {
    channel(name: string): CodecSurface {
      assertNotDestroyed();
      try {
        let result: CodecSurface;
        if (params.document?.hasSurface(name)) {
          result = params.document.surface(name);
        } else if (channels.includes(name)) {
          // No Document or surface not wired yet.
          // Return a standalone surface (lazily
          // created) so callers like tests and
          // rotate can access channel surfaces.
          result = editBridge.getOrCreateFallback(name);
        } else {
          throw new Error(`No surface for channel "${name}"`);
        }
        if (
          name !== "_meta" &&
          !cap.isAdmin &&
          cap.channels.size > 0 &&
          !cap.channels.has(name) &&
          !warnedChannels.has(name)
        ) {
          warnedChannels.add(name);
          log.warn(
            `Channel "${name}" accessed without` +
              " write key — sync disabled for" +
              " this channel. Ask the document" +
              " admin for a re-invite that" +
              " includes this channel.",
          );
        }
        return result;
      } catch {
        throw new Error(
          `Unknown channel "${name}". ` + "Configured: " + channels.join(", "),
        );
      }
    },

    surface(name: string): CodecSurface {
      assertNotDestroyed();
      if (!params.document) {
        throw new Error(
          "surface() requires a Document." + " Pass a document to createDoc().",
        );
      }
      const surface = params.document.surface(name);
      ensureSurfaceBridged(name, surface);
      return surface;
    },

    get awareness(): Awareness {
      return awareness!;
    },

    get capability(): Capability {
      return cap;
    },

    get configuredChannels(): readonly string[] {
      return channels.filter((ch) => ch !== "_meta");
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
      // Include _meta if present in source keys
      // (new docs have it; old docs opened from
      // pre-A2 URLs may not).
      const hasMetaKey = !!(keys.channelKeys && "_meta" in keys.channelKeys);
      const grantWithMeta = {
        ...grant,
        channels: grant.channels
          ? [...(hasMetaKey ? ["_meta"] : []), ...grant.channels]
          : grant.channels,
      };
      const narrowed = narrowCapability(keys, grantWithMeta);
      return buildUrl(origin, ipnsName, narrowed);
    },

    status: statusFeed as Feed<DocStatus>,
    saveState: saveStateFeed as Feed<SaveState>,

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
      syncSaveState();
      factQueue?.push({
        type: "publish-started",
        ts: Date.now(),
      });

      // Materialize snapshot from epoch tree fold.
      const measured = State.channelMeasured(params.codec);
      const plaintext: Record<string, Uint8Array> = {};
      let clockSum = 0;
      for (const ch of channels) {
        const cache = Cache.create<Uint8Array>();
        const state = foldTree<Uint8Array>(
          measured,
          params.document!.channel(ch).tree,
          cache,
        );
        plaintext[ch] = state;
        clockSum += params.codec.clockSum(state);
      }
      // Reset local dirty flag so save state
      // machinery transitions to "saved".
      contentDirty = false;
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
        syncSaveState();
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
      setLastLocalPublishCid?.(cid.toString());

      isSaving = false;
      lastSaveError = null;

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

      // Advance localSnapshotHistory so the
      // versions feed updates immediately.
      const snapshotFact: Fact = {
        type: "snapshot-materialized",
        ts: now,
        channel: channels[0]!,
        epochIndex: 0,
        cid,
        seq: pushResult.seq,
      };
      localSnapshotHistory = reduceSnapshotHistory(
        localSnapshotHistory ??
          interpreterState?.snapshotHistory ??
          INITIAL_SNAPSHOT_HISTORY,
        snapshotFact,
      );

      updateVersionsFeed();

      // Synchronously update tipFeed so consumers
      // see the new CID without waiting for the
      // interpreter pipeline (which may not run in
      // no-P2P / E2E mode).
      lastTipInfo = {
        cid,
        seq: pushResult.seq,
        ackedBy: new Set(),
        guaranteeUntil: 0,
        retainUntil: 0,
      };
      tipFeed._update(lastTipInfo);

      // Sync saveState after localChain is set so
      // deriveSaveState sees chain.tip and returns
      // "saved" instead of "unpublished".
      syncSaveState();

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
          networkId: params.networkId,
          primaryChannel: params.primaryChannel,
          signalingUrls: params.signalingUrls,
          syncOpts: params.syncOpts,
          pubsub: params.pubsub,
          document: params.document!,
          codec: params.codec,
        },
        createDoc,
      );
      teardown();
      return result as RotateResult;
    },

    /* eslint-disable @typescript-eslint/no-explicit-any */
    /** @deprecated Use Feed subscriptions instead. */
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

    /** @deprecated Use Feed subscriptions instead. */
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
      // Also persist to Store and update the
      // versions feed so cached entries survive
      // refresh.
      let feedUpdated = false;
      for (const e of entries) {
        const key = e.cid.toString();
        if (factQueue) {
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
        // Populate localSnapshotHistory so the
        // versions feed includes pinner entries.
        const current =
          localSnapshotHistory ??
          interpreterState?.snapshotHistory ??
          INITIAL_SNAPSHOT_HISTORY;
        const alreadyKnown = current.records.some((r) => r.cid.equals(e.cid));
        if (!alreadyKnown) {
          localSnapshotHistory = reduceSnapshotHistory(current, {
            type: "snapshot-materialized",
            ts: e.ts,
            cid: e.cid,
            seq: e.seq,
            channel: "",
            epochIndex: 0,
          });
          persistSnapshot(e.cid, e.seq, e.ts);
          feedUpdated = true;
        }
      }
      if (feedUpdated) {
        updateVersionsFeed();
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

  if (params.document) {
    docDocuments.set(doc, params.document);
  }

  return doc;
}
