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
import { signEdit } from "./epoch/sign-edit.js";
import type { ParticipantAwareness } from "./identity.js";
import {
  createClientIdMapping,
  setupParticipantAwareness,
} from "./doc-identity.js";
import type { IdentityMap } from "./doc-identity.js";
import { SNAPSHOT_ORIGIN } from "@pokapali/sync";
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import {
  createReconcileChannel,
  createTransport,
  ReconciliationMessageType,
} from "@pokapali/sync";
import {
  createReconciliationWiring,
  type ReconciliationWiring,
} from "./reconciliation-wiring.js";
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
import type { Codec } from "@pokapali/codec";
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
import type { EffectHandlers } from "./interpreter.js";
import {
  deriveStatus,
  deriveLoadingState,
  loadingStateChanged,
  MESH_GRACE_MS,
} from "./doc-status.js";
import { projectFeed } from "./project-feed.js";
import { selectStatus, selectSaveState } from "./state-selectors.js";

const log = createLogger("core");

/**
 * Origin used when replaying edits from Store on
 * startup. Non-null so the Y.Doc editHandler skips
 * re-persisting replayed edits.
 */
const STORE_ORIGIN = "store-replay";

// -------------------------------------------------------
// One-time y-indexeddb hydration
// -------------------------------------------------------

/**
 * Open an IDB database by name, returning null if it
 * does not exist (aborts onupgradeneeded to avoid
 * creating an empty database).
 */
function idbOpen(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => {
        req.transaction!.abort();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Check if a y-indexeddb migration key exists in the
 * Store's meta store.
 */
function metaHas(db: IDBDatabase, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const req = store.get(key);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Mark a y-indexeddb migration as complete in the
 * Store's meta store.
 */
function metaMark(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    store.put({ key, migratedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Hydrate Y.Docs from old y-indexeddb databases.
 *
 * y-indexeddb stores raw Yjs updates in an `updates`
 * object store with auto-increment keys. Each value
 * is a Uint8Array. We read all updates and apply them
 * sequentially to the Y.Doc.
 *
 * Migration is tracked per doc-guid in the Store's
 * meta store (`y-indexeddb:{guid}`). Old databases
 * are left read-only.
 */
async function hydrateFromYIndexeddb(
  document: Document,
  channels: string[],
  ipnsName: string,
  appId: string,
  metaDoc: Y.Doc,
): Promise<void> {
  // Open the unified Store database to check/write
  // meta keys for migration tracking.
  const storeDb = await idbOpen(`pokapali:${appId}`);
  if (!storeDb) return;

  try {
    for (const ch of channels) {
      if (!document.hasSurface(ch)) continue;
      const guid = `${ipnsName}:${ch}`;
      const ydoc = document.surface(ch).handle as Y.Doc;
      await hydrateOneDoc(guid, ydoc, storeDb);
    }
    // Hydrate metaDoc (auth state, client ID
    // mappings, participant awareness).
    await hydrateOneDoc(`${ipnsName}:_meta`, metaDoc, storeDb);
  } finally {
    storeDb.close();
  }
}

async function hydrateOneDoc(
  guid: string,
  ydoc: Y.Doc,
  storeDb: IDBDatabase,
): Promise<void> {
  const metaKey = `y-indexeddb:${guid}`;
  if (await metaHas(storeDb, metaKey)) return;

  const oldDb = await idbOpen(guid);
  if (!oldDb) {
    await metaMark(storeDb, metaKey);
    return;
  }

  try {
    if (!oldDb.objectStoreNames.contains("updates")) {
      await metaMark(storeDb, metaKey);
      return;
    }
    const updates = await new Promise<Uint8Array[]>((resolve, reject) => {
      const tx = oldDb.transaction("updates", "readonly");
      const store = tx.objectStore("updates");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as Uint8Array[]);
      req.onerror = () => reject(req.error);
    });
    for (const update of updates) {
      Y.applyUpdate(ydoc, update, STORE_ORIGIN);
    }
  } finally {
    oldDb.close();
  }

  await metaMark(storeDb, metaKey);
}

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
  /**
   * Get or create a CodecSurface for a channel.
   *
   * Returns the surface's Y.Doc handle for use
   * with TipTap Collaboration. Edits on this doc
   * flow through the epoch tree via onLocalEdit.
   *
   * Requires a Document to have been provided at
   * creation time — throws otherwise.
   */
  surface(name: string): Y.Doc;
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
  /** Resolves when signaling connects after the
   *  initial relay timeout. The new AwarenessRoom
   *  replaces the placeholder passed in
   *  awarenessRoom. */
  upgradeAwareness?: Promise<AwarenessRoom>;
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
  /** Standalone metaDoc for auth state, client ID
   *  mapping, and participant awareness. */
  metaDoc: Y.Doc;
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
    syncManager,
    awarenessRoom,
    cap,
    keys,
    ipnsName,
    origin,
    channels,
    signingKey,
    readKey,
    metaDoc,
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

  // Replay persisted edits from Store into Y.Docs,
  // then hydrate any remaining state from old
  // y-indexeddb databases (one-time migration for
  // users who haven't loaded since A3a). Both paths
  // are idempotent (Y.Doc merges duplicates). Uses
  // STORE_ORIGIN so the editHandler doesn't
  // re-persist replayed edits. Calls markReady()
  // after replay completes so the editor is usable
  // while IPNS resolution continues in background.
  if (params.storeDocument && params.document) {
    const doc = params.document;
    const storeDoc = params.storeDocument;
    const replayPromises: Promise<void>[] = [];
    for (const ch of channels) {
      if (!doc.hasSurface(ch)) continue;
      const ydoc = doc.surface(ch).handle as Y.Doc;
      const p = storeDoc
        .history(ch)
        .load()
        .then((epochs) => {
          for (const epoch of epochs) {
            for (const edit of epoch.edits) {
              Y.applyUpdate(ydoc, edit.payload, STORE_ORIGIN);
            }
          }
        })
        .catch((err) => {
          log.debug("store edit replay failed:", err);
        });
      replayPromises.push(p);
    }
    // After Store replay, hydrate from old
    // y-indexeddb databases and markReady.
    Promise.all(replayPromises)
      .then(() =>
        hydrateFromYIndexeddb(
          params.document!,
          channels,
          params.ipnsName,
          params.appId,
          params.metaDoc,
        ),
      )
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
  // Channels already warned about missing write key —
  // avoids spamming console on repeated channel() calls.
  const warnedChannels = new Set<string>();
  // Active reconciliation wirings (one per peer).
  const reconciliationWirings = new Set<ReconciliationWiring>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-trigger reconciliation when local edits arrive.
  // Debounced to avoid re-running on every keystroke.
  function scheduleReconcile(): void {
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      for (const w of reconciliationWirings) {
        w.reconcile();
      }
    }, 100);
  }

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
      const handle = params.document.surface(ns).handle as Y.Doc;
      const sv = Y.encodeStateVector(handle);
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
  let pendingAnnounceRetry: ReturnType<typeof setTimeout> | null = null;
  let lastLocalPublishCid: string | null = null;
  let lastEmittedAcks = new Set<string>();
  let lastEmittedGuarantees = new Map<
    string,
    { guaranteeUntil: number; retainUntil: number }
  >();
  // --- Feeds ---
  // DocState feed — source of truth for derived
  // status and saveState projections. Updated in
  // captureState() as the interpreter produces new
  // state.
  const docStateInit = initialDocState({
    ipnsName,
    role: cap.isAdmin ? "admin" : cap.channels.size > 0 ? "writer" : "reader",
    channels,
    appId: params.appId ?? "",
  });
  // Set createdAt for mesh grace period and
  // re-derive status so initial value is
  // "connecting" instead of "offline".
  docStateInit.connectivity = {
    ...docStateInit.connectivity,
    createdAt: docCreatedAt,
  };
  docStateInit.status = deriveStatus(docStateInit.connectivity);
  const docStateFeed: WritableFeed<DocState> =
    createFeed<DocState>(docStateInit);
  const statusFeed: Feed<DocStatus> = projectFeed(docStateFeed, selectStatus);
  const saveStateFeed: Feed<SaveState> = projectFeed(
    docStateFeed,
    selectSaveState,
  );

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

  // After grace period expires, re-derive status
  // so it transitions from "connecting" to "offline"
  // if nothing has connected.
  const graceTimer = setTimeout(() => {
    const current = docStateFeed.getSnapshot();
    const fresh = deriveStatus(current.connectivity);
    if (fresh !== current.status) {
      docStateFeed._update({
        ...current,
        status: fresh,
      });
    }
  }, MESH_GRACE_MS + 50);
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
  const clientIdMapping = createClientIdMapping(metaDoc, ipnsName);
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
        log.debug("snapshot persist failed:", err);
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
        log.debug("edit persist failed:", err);
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
  const editBridgeCleanups: Array<() => void> = [];
  const surfaceBridged = new Set<string>();
  // Fallback Y.Docs for channels when no Document
  // is provided (e.g. lazy/solo mode tests).
  const fallbackDocs = new Map<string, Y.Doc>();
  if (params.document) {
    for (const name of channels) {
      if (!params.document.hasSurface(name)) continue;
      const ydoc = params.document.surface(name).handle as Y.Doc;
      const channel = params.document.channel(name);
      const editHandler = (update: Uint8Array, origin: unknown) => {
        // Only capture local user edits (null origin
        // from TipTap/ProseMirror). Skip Store replay,
        // snapshot application, awareness sync, and
        // any other non-local origins.
        if (origin != null) return;
        // Append synchronously so the epoch tree is
        // up-to-date for immediate publish(). The
        // signature is empty here — outgoing wire
        // paths (live forwarding + reconciliation)
        // sign on-the-fly with the envelope format.
        const edit = Edit.create({
          payload: update,
          timestamp: Date.now(),
          author: identityPubkeyHex ?? "",
          channel: name,
          origin: "local",
          signature: new Uint8Array(),
        });
        channel.appendEdit(edit);
        persistEdit(name, edit);
        scheduleReconcile();
        markContentDirty();
      };
      ydoc.on("update", editHandler);
      editBridgeCleanups.push(() => ydoc.off("update", editHandler));

      // Dirty tracking for non-local updates too
      // (e.g. remote edits applied via editListeners).
      const dirtyHandler = (_update: Uint8Array, origin: unknown) => {
        if (origin === SNAPSHOT_ORIGIN) return;
        if (origin == null) return; // handled above
        markContentDirty();
      };
      ydoc.on("update", dirtyHandler);
      editBridgeCleanups.push(() => ydoc.off("update", dirtyHandler));
    }
  }

  // Bridge metaDoc edits to dirty tracking.
  // Previously this flowed through subdocManager's
  // "dirty" event; now we listen directly.
  const metaDirtyHandler = (_update: Uint8Array, origin: unknown) => {
    if (origin === SNAPSHOT_ORIGIN) return;
    markContentDirty();
  };
  metaDoc.on("update", metaDirtyHandler);
  editBridgeCleanups.push(() => metaDoc.off("update", metaDirtyHandler));

  // Wire sync/awareness status bridges. These are
  // called immediately if deps are available, or
  // deferred until p2pReady resolves.
  function wireSyncBridges(_sm: SyncManager, ar: AwarenessRoom): void {
    // Sync status facts are now emitted by
    // transport.onConnectionChange inside
    // wireDataChannel (below), not by
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
    if (!ar.onPeerCreated) return;
    unsubPeerConn?.();
    unsubPeerConn = ar.onPeerCreated((pc, initiator) => {
      if (destroyed || !params.document) return;
      const doc = params.document;

      function wireDataChannel(dc: RTCDataChannel): void {
        dc.binaryType = "arraybuffer";

        const transport = createTransport(dc);
        const wiring = createReconciliationWiring({
          channels,
          getChannel: (name) => doc.channel(name),
          codec: params.codec,
          transport,
          identity: params.identity,
          onRemoteEdit: (ch, edit) => {
            persistEdit(ch, edit);
          },
        });
        reconciliationWirings.add(wiring);

        // Bridge transport connectivity → sync
        // status facts (replaces the old
        // WebrtcProvider status bridge).
        const unsubConn = transport.onConnectionChange((connected) => {
          factQueue?.push({
            type: "sync-status-changed",
            ts: Date.now(),
            status: connected ? "connected" : "disconnected",
          });
        });

        // Live edit forwarding: forward local edits
        // to the peer and apply incoming edits.
        const editUnsubs: Array<() => void> = [];

        function startLiveForwarding(): void {
          for (const ch of channels) {
            const unsub = doc.onEdit(ch, (edit) => {
              // Only forward local edits — remote
              // edits (origin "sync") are already
              // on the peer.
              if (edit.origin !== "local") return;
              if (!transport.connected) return;
              // Sign on-the-fly: produce a 97-byte
              // envelope for the wire. Signing is
              // async (~0.23ms) so we fire-and-forget.
              // If no identity, send the raw signature
              // (empty or pre-signed by Document).
              if (params.identity) {
                void signEdit(edit.payload, params.identity)
                  .then((envelope) => {
                    if (!transport.connected) return;
                    transport.send(ch, {
                      type: ReconciliationMessageType.EDIT_BATCH,
                      channel: ch,
                      edits: [
                        {
                          payload: edit.payload,
                          signature: envelope,
                        },
                      ],
                    });
                  })
                  .catch(() => {
                    // Signing failed — drop silently.
                  });
              } else {
                transport.send(ch, {
                  type: ReconciliationMessageType.EDIT_BATCH,
                  channel: ch,
                  edits: [
                    {
                      payload: edit.payload,
                      signature: edit.signature,
                    },
                  ],
                });
              }
            });
            editUnsubs.push(unsub);
          }
        }

        // Handle incoming live edits (EDIT_BATCH
        // messages that arrive after initial
        // reconciliation).
        const unsubLiveEdits = transport.onMessage((channelName, msg) => {
          if (msg.type !== ReconciliationMessageType.EDIT_BATCH) {
            return;
          }
          const channel = doc.channel(channelName);
          for (const e of msg.edits) {
            const edit = {
              payload: e.payload,
              timestamp: Date.now(),
              author: "",
              channel: channelName,
              origin: "sync" as const,
              signature: e.signature,
            };
            channel.appendEdit(edit);
            persistEdit(channelName, edit);
          }
        });

        // Start reconciliation when channel opens
        if (dc.readyState === "open") {
          wiring.reconcile();
          startLiveForwarding();
        } else {
          dc.addEventListener("open", () => {
            if (!reconciliationWirings.has(wiring)) {
              return;
            }
            wiring.reconcile();
            startLiveForwarding();
          });
        }

        function cleanup() {
          for (const unsub of editUnsubs) unsub();
          editUnsubs.length = 0;
          unsubLiveEdits();
          unsubConn();
          wiring.destroy();
          reconciliationWirings.delete(wiring);
          // If no transports remain, push
          // disconnected so status updates.
          if (reconciliationWirings.size === 0) {
            factQueue?.push({
              type: "sync-status-changed",
              ts: Date.now(),
              status: "disconnected",
            });
          }
        }

        dc.addEventListener("close", cleanup);
        dc.addEventListener("error", cleanup);
      }

      // Initiator creates the data channel before
      // the SDP offer so it's in the negotiation.
      if (initiator) {
        wireDataChannel(createReconcileChannel(pc));
      }

      // Both sides listen for incoming data
      // channels (responder receives the
      // initiator's channel).
      pc.addEventListener("datachannel", (event) => {
        if (event.channel.label === "pokapali-reconcile") {
          wireDataChannel(event.channel);
        }
      });
    });
  }

  if (liveSyncManager && liveAwarenessRoom) {
    wireSyncBridges(liveSyncManager, liveAwarenessRoom);
  }

  // metaDoc was populated before we registered our
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
    ? setupParticipantAwareness(params.identity, awareness, metaDoc, ipnsName)
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
              fq.push({
                type: "cid-discovered",
                ts: e.ts,
                cid: CID.decode(e.cid),
                source: "cache",
                seq: e.seq,
                snapshotTs: e.ts,
              });
            } catch {
              // skip undecodable CIDs
            }
          }
          log.debug("hydrated " + cached.length + " cached versions");
        })
        .catch((err) => {
          log.debug("version cache hydration failed:", err);
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
      metaDoc,
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
              params.networkId,
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
              params.networkId,
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
          const topic = announceTopic(params.networkId, appId);
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
        if (destroyed) return;
        p2pResolved = true;
        liveSyncManager = deps.syncManager;
        liveAwarenessRoom = deps.awarenessRoom;
        wireSyncBridges(deps.syncManager, deps.awarenessRoom);

        // Upgrade awareness room when signaling
        // connects after the initial relay timeout.
        if (deps.upgradeAwareness) {
          deps.upgradeAwareness
            .then((newRoom) => {
              if (destroyed) return;
              log.info("upgrading awareness room");
              liveAwarenessRoom?.destroy();
              liveAwarenessRoom = newRoom;
              wireSyncBridges(deps.syncManager, newRoom);
            })
            .catch((err) => {
              log.debug(
                "awareness upgrade skipped:",
                (err as Error)?.message ?? err,
              );
            });
        }

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
    // Tear down edit bridge
    for (const cleanup of editBridgeCleanups) cleanup();
    editBridgeCleanups.length = 0;
    // Destroy fallback channel docs
    for (const fb of fallbackDocs.values()) fb.destroy();
    fallbackDocs.clear();
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
    // Tear down reconciliation wirings
    if (reconcileTimer) clearTimeout(reconcileTimer);
    unsubPeerConn?.();
    for (const w of reconciliationWirings) w.destroy();
    reconciliationWirings.clear();
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

  // Lazily register a reconciliation trigger on a
  // surface Y.Doc. The surface's onLocalEdit already
  // puts edits in the epoch tree via ch.appendEdit(),
  // but scheduleReconcile() isn't called from that
  // path. This bridges the gap.
  function ensureSurfaceBridged(name: string, handle: Y.Doc): void {
    if (surfaceBridged.has(name)) return;
    surfaceBridged.add(name);
    const handler = (_update: Uint8Array, origin: unknown) => {
      // Skip remote/snapshot origins — only
      // local edits should trigger reconcile.
      if (origin === "remote" || origin === "snapshot") {
        return;
      }
      markContentDirty();
      scheduleReconcile();
    };
    handle.on("update", handler);
    editBridgeCleanups.push(() => handle.off("update", handler));
  }

  const doc = {
    channel(name: string): Y.Doc {
      assertNotDestroyed();
      try {
        let doc: Y.Doc;
        if (name === "_meta") {
          doc = metaDoc;
        } else if (params.document?.hasSurface(name)) {
          doc = params.document.surface(name).handle as Y.Doc;
        } else if (channels.includes(name)) {
          // No Document or surface not wired yet.
          // Return a standalone Y.Doc (lazily
          // created) so callers like tests and
          // rotate can access channel docs.
          let fb = fallbackDocs.get(name);
          if (!fb) {
            fb = new Y.Doc({
              guid: `${ipnsName}:${name}`,
            });
            // Wire dirty tracking on fallback docs
            const dirtyH = (_u: Uint8Array, origin: unknown) => {
              if (origin === SNAPSHOT_ORIGIN) return;
              markContentDirty();
            };
            fb.on("update", dirtyH);
            fallbackDocs.set(name, fb);
          }
          doc = fb;
        } else {
          throw new Error(`No surface for channel "${name}"`);
        }
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

    surface(name: string): Y.Doc {
      assertNotDestroyed();
      if (!params.document) {
        throw new Error(
          "surface() requires a Document." + " Pass a document to createDoc().",
        );
      }
      const handle = params.document.surface(name).handle as Y.Doc;
      ensureSurfaceBridged(name, handle);
      return handle;
    },

    /** @deprecated Use doc.awareness directly. */
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

    /** @deprecated Use tip.getSnapshot()?.ackedBy. */
    get ackedBy(): ReadonlySet<string> {
      if (!interpreterState?.chain.tip) {
        return EMPTY_SET;
      }
      const entry = interpreterState.chain.entries.get(
        interpreterState.chain.tip.toString(),
      );
      return entry?.ackedBy ?? EMPTY_SET;
    },

    /** @deprecated Use tip.getSnapshot()?.guaranteeUntil. */
    get guaranteeUntil(): number | null {
      if (!interpreterState) return null;
      const g = bestGuarantee(interpreterState.chain);
      return g.guaranteeUntil || null;
    },

    /** @deprecated Use tip.getSnapshot()?.retainUntil. */
    get retainUntil(): number | null {
      if (!interpreterState) return null;
      const g = bestGuarantee(interpreterState.chain);
      return g.retainUntil || null;
    },

    /** @deprecated Use tip.getSnapshot()?.cid. */
    get tipCid(): CID | null {
      return snapshotLC.prev;
    },

    /** @deprecated Use loading.getSnapshot(). */
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
      lastLocalPublishCid = cid.toString();

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
        populateMeta,
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
      const map = metaDoc.getMap<true>("authorizedPublishers");
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
      const map = metaDoc.getMap<true>("authorizedPublishers");
      map.delete(pubkey);
    },

    get authorizedPublishers(): ReadonlySet<string> {
      const map = metaDoc.getMap<true>("authorizedPublishers");
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

  if (params.document) {
    docDocuments.set(doc, params.document);
  }

  return doc;
}
