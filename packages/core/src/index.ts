import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
  CapabilityKeys,
} from "@pokapali/capability";
import {
  inferCapability,
  narrowCapability,
  buildUrl,
  parseUrl,
} from "@pokapali/capability";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  hexToBytes,
  bytesToHex,
} from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import { createSubdocManager } from "@pokapali/subdocs";
import type { SubdocManager } from "@pokapali/subdocs";
import {
  setupNamespaceRooms,
  setupAwarenessRoom,
} from "@pokapali/sync";
import type {
  SyncManager,
  AwarenessRoom,
  SyncOptions,
  PubSubLike,
} from "@pokapali/sync";
import { CID } from "multiformats/cid";
import {
  createForwardingRecord,
  encodeForwardingRecord,
  storeForwardingRecord,
  lookupForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import {
  acquireHelia,
  releaseHelia,
  getHeliaPubsub,
  getHelia,
} from "./helia.js";
import {
  publishIPNS,
} from "./ipns-helpers.js";
import {
  announceSnapshot,
} from "./announce.js";
import {
  startRoomDiscovery,
} from "./peer-discovery.js";
import type { RoomDiscovery } from "./peer-discovery.js";
import {
  createSnapshotLifecycle,
} from "./snapshot-lifecycle.js";
import type {
  SnapshotLifecycle,
} from "./snapshot-lifecycle.js";
import {
  createSnapshotWatcher,
} from "./snapshot-watcher.js";
import type {
  SnapshotWatcher,
  LoadingState,
  GossipActivity,
} from "./snapshot-watcher.js";
import {
  createRelaySharing,
} from "./relay-sharing.js";
import type {
  RelaySharing,
} from "./relay-sharing.js";
import {
  acquireNodeRegistry,
  getNodeRegistry,
} from "./node-registry.js";
import type {
  NodeRegistry,
  Neighbor,
} from "./node-registry.js";
import {
  createTopologySharing,
} from "./topology-sharing.js";
import type {
  TopologySharing,
  AwarenessTopology,
} from "./topology-sharing.js";
import { docIdFromUrl } from "./url-utils.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("core");

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface PokapaliConfig {
  appId?: string;
  channels: string[];
  primaryChannel?: string;
  origin: string;
  signalingUrls?: string[];
  bootstrapPeers?: string[];
  rtc?: SyncOptions["peerOpts"];
}

export type DocStatus =
  | "connecting"
  | "synced"
  | "receiving"
  | "offline";

export type SaveState =
  | "saved"
  | "unpublished"
  | "saving"
  | "dirty";

export type {
  GossipActivity,
} from "./snapshot-watcher.js";

export type { LoadingState } from
  "./snapshot-watcher.js";

export interface RotateResult {
  newDoc: Doc;
  forwardingRecord: Uint8Array;
}

export type DocRole = "admin" | "writer" | "reader";

export interface NodeInfo {
  peerId: string;
  short: string;
  connected: boolean;
  roles: string[];
  /** True after a caps broadcast confirms roles. */
  rolesConfirmed: boolean;
  ackedCurrentCid: boolean;
  lastSeenAt: number;
  /** Neighbors reported by this node (v2 caps). */
  neighbors: Neighbor[];
  /** Browser count reported by this node (v2 caps). */
  browserCount: number | undefined;
}

export interface GossipSubDiagnostic {
  peers: number;
  topics: number;
  meshPeers: number;
}

export interface Diagnostics {
  ipfsPeers: number;
  nodes: NodeInfo[];
  editors: number;
  gossipsub: GossipSubDiagnostic;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  ipnsSeq: number | null;
  loadingState: LoadingState;
  hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  ackedBy: string[];
  /** Latest guarantee-until timestamp across all
   *  pinners for the current CID, or null if none. */
  guaranteeUntil: number | null;
  /** Latest retain-until timestamp across all
   *  pinners for the current CID, or null if none. */
  retainUntil: number | null;
  /** Topology edges derived from node-reported
   *  neighbors. Each edge is [sourceId, targetId]. */
  topology: TopologyEdge[];
}

export interface TopologyEdge {
  source: string;
  target: string;
  targetRole?: string;
}

export interface TopologyNode {
  id: string;
  kind: "self" | "relay" | "pinner"
    | "relay+pinner" | "browser";
  label: string;
  connected: boolean;
  roles: string[];
  /** Awareness client ID (for browser nodes). */
  clientId?: number;
  ackedCurrentCid?: boolean;
  browserCount?: number;
}

export interface TopologyGraphEdge {
  source: string;
  target: string;
  connected: boolean;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyGraphEdge[];
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
  readonly status: DocStatus;
  /** Persistence state (dirty → saving → saved). */
  readonly saveState: SaveState;
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
  /**
   * Resolves when the document has meaningful state:
   * either a remote snapshot was applied, initial IPNS
   * resolution found nothing to load, or the document
   * was locally created (resolves immediately).
   */
  ready(): Promise<void>;
  publish(): Promise<void>;
  rotate(): Promise<RotateResult>;
  on(
    event: "status",
    cb: (status: DocStatus) => void,
  ): void;
  on(event: "publish-needed", cb: () => void): void;
  on(event: "snapshot", cb: () => void): void;
  on(
    event: "loading",
    cb: (state: LoadingState) => void,
  ): void;
  on(event: "ack", cb: (peerId: string) => void): void;
  on(
    event: "save",
    cb: (state: SaveState) => void,
  ): void;
  on(event: "node-change", cb: () => void): void;
  off(
    event: "status",
    cb: (status: DocStatus) => void,
  ): void;
  off(
    event: "publish-needed",
    cb: () => void,
  ): void;
  off(
    event: "snapshot",
    cb: () => void,
  ): void;
  off(
    event: "loading",
    cb: (state: LoadingState) => void,
  ): void;
  off(event: "ack", cb: (peerId: string) => void): void;
  off(
    event: "save",
    cb: (state: SaveState) => void,
  ): void;
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
  loadVersion(cid: CID): Promise<Record<string, Y.Doc>>;
  destroy(): void;
}

export interface PokapaliApp {
  create(): Promise<Doc>;
  open(url: string): Promise<Doc>;
  /** Check if a URL matches this app's doc format. */
  isDocUrl(url: string): boolean;
  docIdFromUrl(url: string): string;
}



type SyncStatus =
  | "connecting"
  | "connected"
  | "disconnected";

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
): SaveState {
  if (isSaving) return "saving";
  if (isDirty) return "dirty";
  return "saved";
}

interface DocParams {
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
}

type NodeKind = TopologyNode["kind"];

function nodeKind(roles: string[]): NodeKind {
  const isPinner = roles.includes("pinner");
  const isRelay = roles.includes("relay");
  if (isPinner && isRelay) return "relay+pinner";
  if (isPinner) return "pinner";
  if (isRelay) return "relay";
  return "browser";
}

function createDoc(
  params: DocParams,
): Doc {
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

  const snapshotLC = createSnapshotLifecycle({
    getHelia: () => getHelia(),
  });
  const listeners = new Map<string, Set<Function>>();

  function emit(event: string, ...args: unknown[]) {
    const cbs = listeners.get(event);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }

  // --- Status tracking (3 inputs) ---
  let gossipActivity: GossipActivity = "inactive";
  let isSaving = false;

  let lastStatus = computeStatus(
    syncManager.status,
    awarenessRoom.connected,
    gossipActivity,
  );
  let lastSaveState = computeSaveState(
    subdocManager.isDirty,
    isSaving,
  );

  function checkStatus() {
    const next = computeStatus(
      syncManager.status,
      awarenessRoom.connected,
      gossipActivity,
    );
    if (next !== lastStatus) {
      lastStatus = next;
      emit("status", next);
    }
  }

  function checkSaveState() {
    const next = computeSaveState(
      subdocManager.isDirty,
      isSaving,
    );
    if (next !== lastSaveState) {
      lastSaveState = next;
      emit("save", next);
    }
  }

  function computeClockSum(): number {
    let sum = 0;
    for (const ns of channels) {
      const sv = Y.encodeStateVector(
        subdocManager.subdoc(ns),
      );
      const decoded = Y.decodeStateVector(sv);
      for (const clock of decoded.values()) {
        sum += clock;
      }
    }
    return sum;
  }

  subdocManager.on("dirty", () => {
    checkSaveState();
    emit("publish-needed");
    awarenessRoom.awareness.setLocalStateField(
      "clockSum",
      computeClockSum(),
    );
  });

  syncManager.onStatusChange(() => checkStatus());
  awarenessRoom.onStatusChange(() => checkStatus());

  // If the subdoc is already dirty (e.g. _meta was
  // populated before we registered), fire the event
  // so the auto-save debounce starts.
  if (subdocManager.isDirty) {
    // Defer to next microtask so callers can attach
    // event listeners first.
    queueMicrotask(() => {
      checkSaveState();
      emit("publish-needed");
    });
  }

  // Share relay info with WebRTC peers via awareness.
  let relaySharing: RelaySharing | null = null;
  let topSharing: TopologySharing | null = null;
  let cleanupRelayConnect: (() => void) | null =
    null;
  if (params.roomDiscovery) {
    relaySharing = createRelaySharing({
      awareness: awarenessRoom.awareness,
      roomDiscovery: params.roomDiscovery,
    });
  }

  // Publish relay topology via awareness for graph.
  // Also forward node-registry changes as doc events.
  const nodeChangeHandler = () => emit("node-change");
  try {
    const registry = getNodeRegistry();
    if (registry) {
      const helia = getHelia();
      topSharing = createTopologySharing({
        awareness: awarenessRoom.awareness,
        registry,
        libp2p: (helia as any).libp2p,
      });
      registry.onNodeChange(nodeChangeHandler);
    }
  } catch {
    // Helia not ready yet — skip topology sharing
  }

  // Snapshot watching: announce subscription, IPNS
  // polling, re-announce for writers, initial resolve.
  let snapshotWatcher: SnapshotWatcher | null = null;
  if (readKey && params.pubsub && params.appId) {
    const rk = readKey;
    log.debug(
      "announce setup: pubsub=" +
        !!params.pubsub +
        " appId=" + params.appId,
    );
    snapshotWatcher = createSnapshotWatcher({
      appId: params.appId,
      ipnsName,
      pubsub: params.pubsub,
      getHelia: () => getHelia(),
      isWriter: cap.canPushSnapshots,
      ipnsPublicKeyBytes: hexToBytes(ipnsName),
      performInitialResolve:
        params.performInitialResolve,
      onAck: (peerId) => {
        emit("ack", peerId);
      },
      onGossipActivityChange: (activity) => {
        gossipActivity = activity;
        checkStatus();
      },
      onFetchStateChange: (state) => {
        emit("loading", state);
        // If we return to idle or hit permanent failure
        // without ever applying a snapshot, the document
        // is as ready as it gets — mount the editor so
        // the user sees status indicators instead of a
        // blank loading screen.
        if (
          (state.status === "idle" ||
            state.status === "failed") &&
          !readyResolved &&
          !snapshotWatcher?.hasAppliedSnapshot
        ) {
          markReady();
        }
      },
      onSnapshot: async (cid) => {
        const applied =
          await snapshotLC.applyRemote(
            cid,
            rk,
            (plaintext) =>
              subdocManager.applySnapshot(
                plaintext,
              ),
          );
        if (applied) {
          snapshotLC.setLastIpnsSeq(
            computeClockSum(),
          );
          emit("snapshot");
          markReady();
        }
      },
    });

    // Periodically re-announce the latest snapshot
    // so pinners and new peers discover it even if
    // the original writer is offline.
    snapshotWatcher.startReannounce(
      () => snapshotLC.prev,
      (cidStr) => snapshotLC.getBlock(cidStr),
      () => snapshotLC.lastIpnsSeq,
    );

    // Immediately re-announce when a new relay
    // connects so its pinner discovers the latest
    // snapshot without waiting for the interval.
    if (params.roomDiscovery) {
      const rd = params.roomDiscovery;
      const sw = snapshotWatcher;
      const connectHandler = (
        evt: CustomEvent,
      ) => {
        const pid =
          evt.detail?.toString?.() ?? "";
        if (rd.relayPeerIds.has(pid)) {
          sw.reannounceNow();
        }
      };
      const helia = getHelia();
      helia.libp2p.addEventListener(
        "peer:connect",
        connectHandler,
      );
      cleanupRelayConnect = () => {
        helia.libp2p.removeEventListener(
          "peer:connect",
          connectHandler,
        );
      };
    }
  }

  function teardown() {
    destroyed = true;
    cleanupRelayConnect?.();
    relaySharing?.destroy();
    topSharing?.destroy();
    try {
      getNodeRegistry()
        ?.offNodeChange(nodeChangeHandler);
    } catch {}
    snapshotWatcher?.destroy();
    params.roomDiscovery?.stop();
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
          `Unknown channel "${name}". ` +
            "Configured: " +
            channels.join(", "),
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
          return params.adminUrl
            ?? params.writeUrl
            ?? params.readUrl;
        },
      };
    },

    get role(): DocRole {
      if (cap.isAdmin) return "admin";
      if (cap.namespaces.size > 0) return "writer";
      return "reader";
    },

    async invite(
      grant: CapabilityGrant,
    ): Promise<string> {
      assertNotDestroyed();
      if (grant.namespaces) {
        for (const ns of grant.namespaces) {
          if (!cap.namespaces.has(ns)) {
            throw new Error(
              `Cannot grant "${ns}" ` +
                "— not in own capability",
            );
          }
        }
      }
      if (
        grant.canPushSnapshots &&
        !cap.canPushSnapshots
      ) {
        throw new Error(
          "Cannot grant canPushSnapshots " +
            "— not in own capability",
        );
      }
      const narrowed = narrowCapability(keys, grant);
      return buildUrl(origin, ipnsName, narrowed);
    },

    get status(): DocStatus {
      return computeStatus(
        syncManager.status,
        awarenessRoom.connected,
        gossipActivity,
      );
    },

    get saveState(): SaveState {
      return computeSaveState(
        subdocManager.isDirty,
        isSaving,
      );
    },

    get relays(): ReadonlySet<string> {
      return params.roomDiscovery?.relayPeerIds
        ?? new Set();
    },

    get clockSum(): number {
      return computeClockSum();
    },

    get ipnsSeq(): number | null {
      return snapshotLC.lastIpnsSeq;
    },

    get latestAnnouncedSeq(): number {
      return snapshotWatcher?.latestAnnouncedSeq ?? 0;
    },

    get loadingState(): LoadingState {
      return snapshotWatcher?.fetchState
        ?? { status: "idle" };
    },

    get hasAppliedSnapshot(): boolean {
      return snapshotWatcher
        ?.hasAppliedSnapshot ?? false;
    },

    get ackedBy(): ReadonlySet<string> {
      return snapshotWatcher?.ackedBy
        ?? new Set();
    },

    get guaranteeUntil(): number | null {
      return snapshotWatcher?.guaranteeUntil
        ?? null;
    },

    get retainUntil(): number | null {
      return snapshotWatcher?.retainUntil
        ?? null;
    },

    ready(): Promise<void> {
      return readyPromise;
    },

    async publish(): Promise<void> {
      assertNotDestroyed();
      if (
        !cap.canPushSnapshots ||
        !signingKey ||
        !readKey
      ) {
        return;
      }
      isSaving = true;
      checkSaveState();

      const plaintext = subdocManager.encodeAll();
      const clockSum = this.clockSum;
      const { cid, block } = await snapshotLC.push(
        plaintext,
        readKey,
        signingKey,
        clockSum,
      );

      isSaving = false;
      checkSaveState();
      emit("snapshot");

      // Reset ack tracking synchronously so the UI
      // clears immediately and early acks aren't
      // dropped.
      snapshotWatcher?.trackCidForAcks(
        cid.toString(),
      );

      // Persist to Helia + publish IPNS + announce.
      // Fire-and-forget: don't block the UI on slow
      // DHT operations.
      const cidShort = cid.toString().slice(0, 16);
      log.info(
        "publish: cid=" +
          cidShort + "... clockSum=" + clockSum,
      );
      (async () => {
        const helia = getHelia();
        log.debug(
          "blockstore.put...",
          cidShort + "...",
        );
        await Promise.resolve(
          helia.blockstore.put(cid, block),
        );
        log.debug(
          "blockstore.put done,"
            + " publishing IPNS...",
        );
        await publishIPNS(
          helia, keys.ipnsKeyBytes!, cid,
          clockSum,
        );
        log.debug("IPNS published, announcing...");
        if (params.appId && params.pubsub) {
          await announceSnapshot(
            params.pubsub,
            params.appId,
            ipnsName,
            cid.toString(),
            clockSum,
            block,
          );
          log.debug("announce sent");
        }
      })().catch((err: unknown) => {
        log.error(
          "IPNS publish/announce failed:", err,
        );
      });
    },

    async rotate(): Promise<RotateResult> {
      assertNotDestroyed();
      if (!cap.isAdmin || !keys.rotationKey) {
        throw new Error(
          "Only admins can rotate" +
            " (requires rotationKey)",
        );
      }

      const newAdminSecret = generateAdminSecret();
      const newDocKeys = await deriveDocKeys(
        newAdminSecret,
        params.appId,
        channels,
      );

      const newSigningKey =
        await ed25519KeyPairFromSeed(
          newDocKeys.ipnsKeyBytes,
        );
      const newIpnsName = bytesToHex(
        newSigningKey.publicKey,
      );

      // Copy current state to new subdoc manager
      const newSubdocManager = createSubdocManager(
        newIpnsName,
        channels,
        {
          primaryNamespace: params.primaryChannel,
        },
      );
      const snapshot = subdocManager.encodeAll();
      newSubdocManager.applySnapshot(snapshot);

      const rotateSyncOpts: SyncOptions = {
        ...params.syncOpts,
        ...(params.pubsub
          ? { pubsub: params.pubsub }
          : {}),
      };

      const newSyncManager = setupNamespaceRooms(
        newIpnsName,
        newSubdocManager,
        newDocKeys.namespaceKeys,
        params.signalingUrls,
        rotateSyncOpts,
      );

      const newAwarenessRoom = setupAwarenessRoom(
        newIpnsName,
        newDocKeys.awarenessRoomPassword,
        params.signalingUrls,
        rotateSyncOpts,
      );

      const newKeys: CapabilityKeys = {
        readKey: newDocKeys.readKey,
        ipnsKeyBytes: newDocKeys.ipnsKeyBytes,
        rotationKey: newDocKeys.rotationKey,
        awarenessRoomPassword:
          newDocKeys.awarenessRoomPassword,
        namespaceKeys: newDocKeys.namespaceKeys,
      };

      const newAdminUrl = await buildUrl(
        origin,
        newIpnsName,
        newKeys,
      );
      const newWriteUrl = await buildUrl(
        origin,
        newIpnsName,
        narrowCapability(newKeys, {
          namespaces: [...channels],
          canPushSnapshots: true,
        }),
      );
      const newReadUrl = await buildUrl(
        origin,
        newIpnsName,
        narrowCapability(newKeys, {
          namespaces: [],
        }),
      );

      const newCap = inferCapability(
        newKeys,
        channels,
      );

      // Populate _meta on new doc
      const newMeta = newSubdocManager.metaDoc;
      const canPush =
        newMeta.getArray<Uint8Array>(
          "canPushSnapshots",
        );
      canPush.push([newSigningKey.publicKey]);
      const authorized =
        newMeta.getMap("authorized");
      for (const [ns, key] of Object.entries(
        newDocKeys.namespaceKeys,
      )) {
        const arr = new Y.Array<Uint8Array>();
        authorized.set(ns, arr);
        arr.push([key]);
      }

      let newRoomDiscovery: RoomDiscovery | undefined;
      try {
        newRoomDiscovery = startRoomDiscovery(
          getHelia(),
          params.appId,
        );
      } catch {
        // Helia may not be available
      }

      const newDoc = createDoc({
        subdocManager: newSubdocManager,
        syncManager: newSyncManager,
        awarenessRoom: newAwarenessRoom,
        cap: newCap,
        keys: newKeys,
        ipnsName: newIpnsName,
        origin,
        channels,
        adminUrl: newAdminUrl,
        writeUrl: newWriteUrl,
        readUrl: newReadUrl,
        signingKey: newSigningKey,
        readKey: newDocKeys.readKey,
        appId: params.appId,
        primaryChannel: params.primaryChannel,
        signalingUrls: params.signalingUrls,
        syncOpts: params.syncOpts,
        pubsub: params.pubsub,
        roomDiscovery: newRoomDiscovery,
      });

      // Create and store forwarding record
      const fwdRecord =
        await createForwardingRecord(
          ipnsName,
          newIpnsName,
          newReadUrl,
          keys.rotationKey,
        );
      const encoded =
        encodeForwardingRecord(fwdRecord);
      storeForwardingRecord(ipnsName, encoded);

      // Destroy old doc
      teardown();

      return {
        newDoc,
        forwardingRecord: encoded,
      };
    },

    on(
      event: string,
      // eslint-disable-next-line
      cb: (...args: any[]) => void,
    ) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    off(
      event: string,
      // eslint-disable-next-line
      cb: (...args: any[]) => void,
    ) {
      listeners.get(event)?.delete(cb);
    },

    diagnostics(): Diagnostics {
      assertNotDestroyed();
      let ipfsPeers = 0;
      const nodeList: NodeInfo[] = [];
      let gossipsub: GossipSubDiagnostic = {
        peers: 0,
        topics: 0,
        meshPeers: 0,
      };

      const ackedSet = snapshotWatcher?.ackedBy
        ?? new Set<string>();

      try {
        const helia = getHelia();
        const libp2p = (helia as any).libp2p;
        ipfsPeers = libp2p.getPeers().length;

        // Build node list from registry
        const registry = getNodeRegistry();
        const seenPids = new Set<string>();
        if (registry) {
          for (const node of registry.nodes
            .values()
          ) {
            seenPids.add(node.peerId);
            const acked =
              ackedSet.has(node.peerId);
            // If peer acked, it's a pinner even
            // if caps didn't include that role.
            const roles = acked &&
              !node.roles.includes("pinner")
              ? [...node.roles, "pinner"]
              : node.roles;
            nodeList.push({
              peerId: node.peerId,
              short: node.peerId.slice(-8),
              connected: node.connected,
              roles,
              rolesConfirmed: true,
              ackedCurrentCid: acked,
              lastSeenAt: node.lastSeenAt,
              neighbors: node.neighbors,
              browserCount: node.browserCount,
            });
          }
        }

        // Merge DHT-discovered relays not yet in
        // the registry (before caps broadcast).
        // Roles unknown until caps arrives.
        const dhtRelays =
          params.roomDiscovery?.relayPeerIds;
        if (dhtRelays) {
          for (const pid of dhtRelays) {
            if (seenPids.has(pid)) continue;
            const conns = libp2p.getConnections();
            const connected = conns.some(
              (c: any) =>
                c.remotePeer.toString() === pid,
            );
            const acked = ackedSet.has(pid);
            nodeList.push({
              peerId: pid,
              short: pid.slice(-8),
              connected,
              roles: acked
                ? ["relay", "pinner"]
                : ["relay"],
              rolesConfirmed: false,
              ackedCurrentCid: acked,
              lastSeenAt: 0,
              neighbors: [],
              browserCount: undefined,
            });
          }
        }

        try {
          const pubsub = libp2p.services.pubsub;
          const topics: string[] =
            pubsub.getTopics?.() ?? [];
          const gsPeers =
            pubsub.getPeers?.() ?? [];
          const mesh = (pubsub as any).mesh as
            | Map<string, Set<string>>
            | undefined;
          let meshPeers = 0;
          if (mesh) {
            for (const set of mesh.values()) {
              meshPeers += set.size;
            }
          }
          gossipsub = {
            peers: gsPeers.length,
            topics: topics.length,
            meshPeers,
          };
        } catch {}
      } catch (err) {
        log.warn(
          "diagnostics error:",
          (err as Error)?.message ?? err,
        );
      }

      let maxPeerClockSum = 0;
      let editors = 1;
      try {
        const states =
          awarenessRoom.awareness.getStates();
        editors = Math.max(1, states.size);
        for (const [, state] of states) {
          const cs = (state as any)?.clockSum;
          if (
            typeof cs === "number" &&
            cs > maxPeerClockSum
          ) {
            maxPeerClockSum = cs;
          }
        }
      } catch {}

      // Build topology edges from node neighbors
      const topology: TopologyEdge[] = [];
      for (const node of nodeList) {
        for (const nb of node.neighbors) {
          topology.push({
            source: node.peerId,
            target: nb.peerId,
            ...(nb.role ? { targetRole: nb.role }
              : {}),
          });
        }
      }

      return {
        ipfsPeers,
        nodes: nodeList,
        editors,
        gossipsub,
        clockSum: computeClockSum(),
        maxPeerClockSum,
        latestAnnouncedSeq:
          snapshotWatcher?.latestAnnouncedSeq ?? 0,
        ipnsSeq: snapshotLC.lastIpnsSeq,
        loadingState: snapshotWatcher?.fetchState
          ?? { status: "idle" },
        hasAppliedSnapshot:
          snapshotWatcher?.hasAppliedSnapshot
            ?? false,
        ackedBy: [...ackedSet],
        guaranteeUntil:
          snapshotWatcher?.guaranteeUntil ?? null,
        retainUntil:
          snapshotWatcher?.retainUntil ?? null,
        topology,
      };
    },

    topologyGraph(): TopologyGraph {
      assertNotDestroyed();
      const info = this.diagnostics();
      const graphNodes: TopologyNode[] = [];
      const edges: TopologyGraphEdge[] = [];
      const seenNodeIds = new Set<string>();

      // 1. Self node
      graphNodes.push({
        id: "_self",
        kind: "self",
        label: "You",
        connected: true,
        roles: [],
      });

      // 2. Infrastructure nodes from diagnostics
      for (const n of info.nodes) {
        seenNodeIds.add(n.peerId);
        graphNodes.push({
          id: n.peerId,
          kind: nodeKind(n.roles),
          label: `...${n.short}`,
          connected: n.connected,
          roles: n.roles,
          ackedCurrentCid: n.ackedCurrentCid,
          browserCount: n.browserCount,
        });
        edges.push({
          source: "_self",
          target: n.peerId,
          connected: n.connected,
        });
      }

      // 3. Relay-relay edges from node-registry
      for (const te of info.topology) {
        edges.push({
          source: te.source,
          target: te.target,
          connected: true,
        });
      }

      // 4. Peer browser nodes, their relay edges,
      //    and browser-to-browser edges from
      //    awareness topology state.
      const states =
        awarenessRoom.awareness.getStates();
      const myClientId =
        awarenessRoom.awareness.clientID;

      for (const [clientId, state] of states) {
        if (clientId === myClientId) continue;
        const topo =
          (state as any)?.topology as
            AwarenessTopology | undefined;

        const peerId = `awareness:${clientId}`;
        graphNodes.push({
          id: peerId,
          kind: "browser",
          label:
            (state as any)?.user?.name
              ?? `Peer ${clientId}`,
          connected: true,
          roles: [],
          clientId,
        });

        // Edge from self to this browser peer
        edges.push({
          source: "_self",
          target: peerId,
          connected: true,
        });

        // Relay edges from this browser peer
        if (topo?.connectedRelays) {
          for (const relayPid of
            topo.connectedRelays
          ) {
            // Ensure the relay node exists
            if (!seenNodeIds.has(relayPid)) {
              seenNodeIds.add(relayPid);
              const relayRoles =
                topo.relayRoles?.[relayPid]
                  ?? [];
              graphNodes.push({
                id: relayPid,
                kind: nodeKind(relayRoles),
                label:
                  `...${relayPid.slice(-8)}`,
                connected: false,
                roles: relayRoles,
              });
            }
            edges.push({
              source: peerId,
              target: relayPid,
              connected: true,
            });
          }
        }

        // Browser-to-browser edges from
        // reported connectedPeers
        if (topo?.connectedPeers) {
          for (const peerCid of
            topo.connectedPeers
          ) {
            if (peerCid === myClientId) continue;
            const targetId =
              `awareness:${peerCid}`;
            edges.push({
              source: peerId,
              target: targetId,
              connected: true,
            });
          }
        }
      }

      return { nodes: graphNodes, edges };
    },

    async history() {
      assertNotDestroyed();
      return snapshotLC.history();
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

export function pokapali(
  options: PokapaliConfig,
): PokapaliApp {
  const { channels, origin } = options;
  const appId = options.appId ?? "";
  const primaryChannel =
    options.primaryChannel ?? channels[0];
  const signalingUrls = options.signalingUrls ?? [];
  const bootstrapPeers = options.bootstrapPeers;

  return {
    async create(): Promise<Doc> {
      await acquireHelia({ bootstrapPeers });
      try {
      const pubsub =
        getHeliaPubsub() as unknown as PubSubLike;
      acquireNodeRegistry(pubsub, () => getHelia());

      const userIce =
        options.rtc?.config?.iceServers;
      const syncOpts: SyncOptions = {
        peerOpts: {
          config: {
            iceServers: userIce ?? DEFAULT_ICE_SERVERS,
          },
        },
        pubsub,
      };

      const adminSecret = generateAdminSecret();
      const docKeys = await deriveDocKeys(
        adminSecret,
        appId,
        channels,
      );

      const signingKey =
        await ed25519KeyPairFromSeed(
          docKeys.ipnsKeyBytes,
        );
      const ipnsName = bytesToHex(
        signingKey.publicKey,
      );

      const subdocManager = createSubdocManager(
        ipnsName,
        channels,
        {
          primaryNamespace: primaryChannel,
        },
      );

      const syncManager = setupNamespaceRooms(
        ipnsName,
        subdocManager,
        docKeys.namespaceKeys,
        signalingUrls,
        syncOpts,
      );

      const awarenessRoom = setupAwarenessRoom(
        ipnsName,
        docKeys.awarenessRoomPassword,
        signalingUrls,
        syncOpts,
      );

      const roomDiscovery = startRoomDiscovery(
        getHelia(),
        appId,
      );

      const fullKeys: CapabilityKeys = {
        readKey: docKeys.readKey,
        ipnsKeyBytes: docKeys.ipnsKeyBytes,
        rotationKey: docKeys.rotationKey,
        awarenessRoomPassword:
          docKeys.awarenessRoomPassword,
        namespaceKeys: docKeys.namespaceKeys,
      };

      const adminUrl = await buildUrl(
        origin,
        ipnsName,
        fullKeys,
      );
      const writeUrl = await buildUrl(
        origin,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [...channels],
          canPushSnapshots: true,
        }),
      );
      const readUrl = await buildUrl(
        origin,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [],
        }),
      );

      const cap = inferCapability(
        fullKeys,
        channels,
      );

      // Populate _meta doc
      const meta = subdocManager.metaDoc;
      const canPush =
        meta.getArray<Uint8Array>(
          "canPushSnapshots",
        );
      canPush.push([signingKey.publicKey]);
      const authorized =
        meta.getMap("authorized");
      for (const [ns, key] of Object.entries(
        docKeys.namespaceKeys,
      )) {
        const arr = new Y.Array<Uint8Array>();
        authorized.set(ns, arr);
        arr.push([key]);
      }

      return createDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys: fullKeys,
        ipnsName,
        origin,
        channels,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: docKeys.readKey,
        appId,
        primaryChannel,
        signalingUrls,
        syncOpts,
        pubsub,
        roomDiscovery,
      });
      } catch (err) {
        await releaseHelia();
        throw err;
      }
    },

    async open(url: string): Promise<Doc> {
      const parsed = await parseUrl(url);
      const { ipnsName, keys } = parsed;

      // Check for forwarding record
      const fwdBytes =
        lookupForwardingRecord(ipnsName);
      if (fwdBytes) {
        const fwd =
          decodeForwardingRecord(fwdBytes);
        if (keys.rotationKey) {
          const valid =
            await verifyForwardingRecord(
              fwd,
              keys.rotationKey,
            );
          if (!valid) {
            throw new Error(
              "Invalid forwarding record" +
                " signature",
            );
          }
        }
        return this.open(fwd.newUrl);
      }

      await acquireHelia({ bootstrapPeers });
      try {
      const pubsub =
        getHeliaPubsub() as unknown as PubSubLike;
      acquireNodeRegistry(pubsub, () => getHelia());

      const userIce =
        options.rtc?.config?.iceServers;
      const syncOpts: SyncOptions = {
        peerOpts: {
          config: {
            iceServers: userIce ?? DEFAULT_ICE_SERVERS,
          },
        },
        pubsub,
      };

      const cap = inferCapability(
        keys,
        channels,
      );

      const subdocManager = createSubdocManager(
        ipnsName,
        channels,
        {
          primaryNamespace: primaryChannel,
        },
      );

      const nsKeys = keys.namespaceKeys ?? {};
      const syncManager = setupNamespaceRooms(
        ipnsName,
        subdocManager,
        nsKeys,
        signalingUrls,
        syncOpts,
      );

      const awarenessRoom = setupAwarenessRoom(
        ipnsName,
        keys.awarenessRoomPassword ?? "",
        signalingUrls,
        syncOpts,
      );

      const roomDiscovery = startRoomDiscovery(
        getHelia(),
        appId,
      );

      const adminUrl = keys.rotationKey
        ? await buildUrl(origin, ipnsName, keys)
        : null;
      const writeUrl = keys.ipnsKeyBytes
        ? await buildUrl(
            origin,
            ipnsName,
            narrowCapability(keys, {
              namespaces: [...cap.namespaces],
              canPushSnapshots: true,
            }),
          )
        : null;
      const readUrl = await buildUrl(
        origin,
        ipnsName,
        narrowCapability(keys, {
          namespaces: [],
        }),
      );

      let signingKey: Ed25519KeyPair | null = null;
      if (keys.ipnsKeyBytes) {
        signingKey =
          await ed25519KeyPairFromSeed(
            keys.ipnsKeyBytes,
          );
      }

      const doc = createDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys,
        ipnsName,
        origin,
        channels,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: keys.readKey,
        appId,
        primaryChannel,
        signalingUrls,
        syncOpts,
        pubsub,
        roomDiscovery,
        performInitialResolve: !!keys.readKey,
      });

      return doc;
      } catch (err) {
        await releaseHelia();
        throw err;
      }
    },

    isDocUrl(url: string): boolean {
      try {
        const parsed = new URL(url);
        const prefix = origin.replace(/\/$/, "")
          + "/doc/";
        const orig = new URL(prefix).origin;
        const path = new URL(prefix).pathname;
        return parsed.origin === orig
          && parsed.pathname.startsWith(path)
          && parsed.hash.length > 1;
      } catch {
        return false;
      }
    },

    docIdFromUrl(url: string): string {
      return docIdFromUrl(url);
    },
  };
}

export {
  encodeForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
  clearForwardingStore,
} from "./forwarding.js";
export type {
  ForwardingRecord,
} from "./forwarding.js";
export { getHelia } from "./helia.js";
export {
  createAutoSaver,
} from "./auto-save.js";
export type {
  AutoSaveOptions,
} from "./auto-save.js";
export { truncateUrl, docIdFromUrl } from "./url-utils.js";
export {
  NODE_CAPS_TOPIC,
  _resetNodeRegistry,
} from "./node-registry.js";
export type {
  KnownNode,
  Neighbor,
  NodeRegistry,
} from "./node-registry.js";
export type {
  AwarenessTopology,
} from "./topology-sharing.js";
