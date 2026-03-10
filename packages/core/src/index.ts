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
  SnapshotFetchState,
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
import type { NodeRegistry } from "./node-registry.js";
import { docIdFromUrl } from "./url-utils.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("core");

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface CollabLibOptions {
  appId?: string;
  namespaces: string[];
  primaryNamespace?: string;
  base: string;
  signalingUrls?: string[];
  bootstrapPeers?: string[];
  peerOpts?: SyncOptions["peerOpts"];
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

export type { SnapshotFetchState } from
  "./snapshot-watcher.js";

export interface RotateResult {
  newDoc: CollabDoc;
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
}

export interface GossipSubDiagnostic {
  peers: number;
  topics: number;
  meshPeers: number;
}

export interface DiagnosticsInfo {
  ipfsPeers: number;
  nodes: NodeInfo[];
  editors: number;
  gossipsub: GossipSubDiagnostic;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  ipnsSeq: number | null;
  fetchState: SnapshotFetchState;
  hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  ackedBy: string[];
}

export interface CollabDoc {
  subdoc(ns: string): Y.Doc;
  readonly provider: {
    readonly awareness: Awareness;
  };
  readonly awareness: Awareness;
  readonly capability: Capability;
  readonly adminUrl: string | null;
  readonly writeUrl: string | null;
  readonly readUrl: string;
  /** Best available URL (admin > write > read). */
  readonly bestUrl: string;
  /** Role derived from capability. */
  readonly role: DocRole;
  inviteUrl(grant: CapabilityGrant): Promise<string>;
  readonly status: DocStatus;
  /** Persistence state (dirty → saving → saved). */
  readonly saveState: SaveState;
  /** Peer IDs of relays discovered for this app. */
  readonly relayPeerIds: ReadonlySet<string>;
  /** Sum of all Y.Doc state vector clocks. */
  readonly clockSum: number;
  /** Last IPNS sequence number used for publish. */
  readonly ipnsSeq: number | null;
  /** Highest seq seen in GossipSub announcements. */
  readonly latestAnnouncedSeq: number;
  /** Current snapshot fetch lifecycle state. */
  readonly snapshotFetchState: SnapshotFetchState;
  /** True after first remote snapshot applied. */
  readonly hasAppliedSnapshot: boolean;
  /** Peer IDs of pinners that acked the latest CID. */
  readonly ackedBy: ReadonlySet<string>;
  /**
   * Resolves when the document has meaningful state:
   * either a remote snapshot was applied, initial IPNS
   * resolution found nothing to load, or the document
   * was locally created (resolves immediately).
   */
  whenReady(): Promise<void>;
  pushSnapshot(): Promise<void>;
  rotate(): Promise<RotateResult>;
  on(
    event: "status",
    cb: (status: DocStatus) => void,
  ): void;
  on(event: "snapshot-recommended", cb: () => void): void;
  on(event: "snapshot-applied", cb: () => void): void;
  on(
    event: "fetch-state",
    cb: (state: SnapshotFetchState) => void,
  ): void;
  on(event: "ack", cb: (peerId: string) => void): void;
  on(
    event: "save-state",
    cb: (state: SaveState) => void,
  ): void;
  off(
    event: "status",
    cb: (status: DocStatus) => void,
  ): void;
  off(
    event: "snapshot-recommended",
    cb: () => void,
  ): void;
  off(
    event: "snapshot-applied",
    cb: () => void,
  ): void;
  off(
    event: "fetch-state",
    cb: (state: SnapshotFetchState) => void,
  ): void;
  off(event: "ack", cb: (peerId: string) => void): void;
  off(
    event: "save-state",
    cb: (state: SaveState) => void,
  ): void;
  diagnostics(): DiagnosticsInfo;
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

export interface CollabLib {
  create(): Promise<CollabDoc>;
  open(url: string): Promise<CollabDoc>;
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

interface CollabDocParams {
  subdocManager: SubdocManager;
  syncManager: SyncManager;
  awarenessRoom: AwarenessRoom;
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  base: string;
  namespaces: string[];
  adminUrl: string | null;
  writeUrl: string | null;
  readUrl: string;
  signingKey: Ed25519KeyPair | null;
  readKey: CryptoKey | undefined;
  appId: string;
  primaryNamespace: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  roomDiscovery?: RoomDiscovery;
  performInitialResolve?: boolean;
}

function createCollabDoc(
  params: CollabDocParams,
): CollabDoc {
  const {
    subdocManager,
    syncManager,
    awarenessRoom,
    cap,
    keys,
    ipnsName,
    base,
    namespaces,
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
      emit("save-state", next);
    }
  }

  function computeClockSum(): number {
    let sum = 0;
    for (const ns of namespaces) {
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
    emit("snapshot-recommended");
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
      emit("snapshot-recommended");
    });
  }

  // Share relay info with WebRTC peers via awareness.
  let relaySharing: RelaySharing | null = null;
  let cleanupRelayConnect: (() => void) | null =
    null;
  if (params.roomDiscovery) {
    relaySharing = createRelaySharing({
      awareness: awarenessRoom.awareness,
      roomDiscovery: params.roomDiscovery,
    });
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
        emit("fetch-state", state);
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
          emit("snapshot-applied");
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
    snapshotWatcher?.destroy();
    params.roomDiscovery?.stop();
    syncManager.destroy();
    awarenessRoom.destroy();
    subdocManager.destroy();
    releaseHelia();
  }

  function assertNotDestroyed() {
    if (destroyed) {
      throw new Error("CollabDoc destroyed");
    }
  }

  const providerObj = {
    get awareness(): Awareness {
      return awarenessRoom.awareness;
    },
  };

  return {
    subdoc(ns: string): Y.Doc {
      assertNotDestroyed();
      try {
        return subdocManager.subdoc(ns);
      } catch {
        throw new Error(
          `Unknown namespace "${ns}". ` +
            "Configured: " +
            namespaces.join(", "),
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

    adminUrl: params.adminUrl,
    writeUrl: params.writeUrl,
    readUrl: params.readUrl,

    get bestUrl(): string {
      return params.adminUrl
        ?? params.writeUrl
        ?? params.readUrl;
    },

    get role(): DocRole {
      if (cap.isAdmin) return "admin";
      if (cap.namespaces.size > 0) return "writer";
      return "reader";
    },

    async inviteUrl(
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
      return buildUrl(base, ipnsName, narrowed);
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

    get relayPeerIds(): ReadonlySet<string> {
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

    get snapshotFetchState(): SnapshotFetchState {
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

    whenReady(): Promise<void> {
      return readyPromise;
    },

    async pushSnapshot(): Promise<void> {
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
      emit("snapshot-applied");

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
        "pushSnapshot: cid=" +
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
        namespaces,
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
        namespaces,
        {
          primaryNamespace: params.primaryNamespace,
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
        base,
        newIpnsName,
        newKeys,
      );
      const newWriteUrl = await buildUrl(
        base,
        newIpnsName,
        narrowCapability(newKeys, {
          namespaces: [...namespaces],
          canPushSnapshots: true,
        }),
      );
      const newReadUrl = await buildUrl(
        base,
        newIpnsName,
        narrowCapability(newKeys, {
          namespaces: [],
        }),
      );

      const newCap = inferCapability(
        newKeys,
        namespaces,
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

      const newDoc = createCollabDoc({
        subdocManager: newSubdocManager,
        syncManager: newSyncManager,
        awarenessRoom: newAwarenessRoom,
        cap: newCap,
        keys: newKeys,
        ipnsName: newIpnsName,
        base,
        namespaces,
        adminUrl: newAdminUrl,
        writeUrl: newWriteUrl,
        readUrl: newReadUrl,
        signingKey: newSigningKey,
        readKey: newDocKeys.readKey,
        appId: params.appId,
        primaryNamespace: params.primaryNamespace,
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

    diagnostics(): DiagnosticsInfo {
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
              roles: acked ? ["pinner"] : [],
              rolesConfirmed: false,
              ackedCurrentCid: acked,
              lastSeenAt: 0,
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
      } catch {
        // Helia not ready
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
        fetchState: snapshotWatcher?.fetchState
          ?? { status: "idle" },
        hasAppliedSnapshot:
          snapshotWatcher?.hasAppliedSnapshot
            ?? false,
        ackedBy: [...ackedSet],
      };
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
  } as CollabDoc;
}

export function createCollabLib(
  options: CollabLibOptions,
): CollabLib {
  const { namespaces, base } = options;
  const appId = options.appId ?? "";
  const primaryNamespace =
    options.primaryNamespace ?? namespaces[0];
  const signalingUrls = options.signalingUrls ?? [];
  const bootstrapPeers = options.bootstrapPeers;

  return {
    async create(): Promise<CollabDoc> {
      await acquireHelia({ bootstrapPeers });
      try {
      const pubsub =
        getHeliaPubsub() as unknown as PubSubLike;
      acquireNodeRegistry(pubsub, () => getHelia());

      const userIce =
        options.peerOpts?.config?.iceServers;
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
        namespaces,
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
        namespaces,
        {
          primaryNamespace,
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
        base,
        ipnsName,
        fullKeys,
      );
      const writeUrl = await buildUrl(
        base,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [...namespaces],
          canPushSnapshots: true,
        }),
      );
      const readUrl = await buildUrl(
        base,
        ipnsName,
        narrowCapability(fullKeys, {
          namespaces: [],
        }),
      );

      const cap = inferCapability(
        fullKeys,
        namespaces,
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

      return createCollabDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys: fullKeys,
        ipnsName,
        base,
        namespaces,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: docKeys.readKey,
        appId,
        primaryNamespace,
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

    async open(url: string): Promise<CollabDoc> {
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
        options.peerOpts?.config?.iceServers;
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
        namespaces,
      );

      const subdocManager = createSubdocManager(
        ipnsName,
        namespaces,
        {
          primaryNamespace,
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
        ? await buildUrl(base, ipnsName, keys)
        : null;
      const writeUrl = keys.ipnsKeyBytes
        ? await buildUrl(
            base,
            ipnsName,
            narrowCapability(keys, {
              namespaces: [...cap.namespaces],
              canPushSnapshots: true,
            }),
          )
        : null;
      const readUrl = await buildUrl(
        base,
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

      const doc = createCollabDoc({
        subdocManager,
        syncManager,
        awarenessRoom,
        cap,
        keys,
        ipnsName,
        base,
        namespaces,
        adminUrl,
        writeUrl,
        readUrl,
        signingKey,
        readKey: keys.readKey,
        appId,
        primaryNamespace,
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
        const prefix = base.replace(/\/$/, "")
          + "/doc/";
        const origin = new URL(prefix).origin;
        const path = new URL(prefix).pathname;
        return parsed.origin === origin
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
  NodeRegistry,
} from "./node-registry.js";
