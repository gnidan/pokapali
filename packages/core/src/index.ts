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
} from "./snapshot-watcher.js";
import {
  createRelaySharing,
} from "./relay-sharing.js";
import type {
  RelaySharing,
} from "./relay-sharing.js";
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
  | "syncing"
  | "synced"
  | "offline"
  | "unpushed-changes";

export type { SnapshotFetchState } from
  "./snapshot-watcher.js";

export interface RotateResult {
  newDoc: CollabDoc;
  forwardingRecord: Uint8Array;
}

export interface RelayDiagnostic {
  peerId: string;
  short: string;
  connected: boolean;
}

export interface GossipSubDiagnostic {
  peers: number;
  topics: number;
  meshPeers: number;
}

export interface DiagnosticsInfo {
  ipfsPeers: number;
  relays: RelayDiagnostic[];
  editors: number;
  gossipsub: GossipSubDiagnostic;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  ipnsSeq: number | null;
  fetchState: SnapshotFetchState;
  hasAppliedSnapshot: boolean;
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
  inviteUrl(grant: CapabilityGrant): Promise<string>;
  readonly status: DocStatus;
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
}



type SyncStatus =
  | "connecting"
  | "connected"
  | "disconnected";

function computeStatus(
  syncStatus: SyncStatus,
  isDirty: boolean,
): DocStatus {
  if (syncStatus === "disconnected") return "offline";
  if (syncStatus === "connecting") return "connecting";
  if (isDirty) return "unpushed-changes";
  return "synced";
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

  let lastStatus = computeStatus(
    syncManager.status,
    subdocManager.isDirty,
  );

  function checkStatus() {
    const next = computeStatus(
      syncManager.status,
      subdocManager.isDirty,
    );
    if (next !== lastStatus) {
      lastStatus = next;
      emit("status", next);
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
    checkStatus();
    emit("snapshot-recommended");
    awarenessRoom.awareness.setLocalStateField(
      "clockSum",
      computeClockSum(),
    );
  });

  // If the subdoc is already dirty (e.g. _meta was
  // populated before we registered), fire the event
  // so the auto-save debounce starts.
  if (subdocManager.isDirty) {
    // Defer to next microtask so callers can attach
    // event listeners first.
    queueMicrotask(() => {
      checkStatus();
      emit("snapshot-recommended");
    });
  }

  // Share relay info with WebRTC peers via awareness.
  let relaySharing: RelaySharing | null = null;
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
      onFetchStateChange: (state) => {
        emit("fetch-state", state);
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
  }

  function teardown() {
    destroyed = true;
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
        subdocManager.isDirty,
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

    async pushSnapshot(): Promise<void> {
      assertNotDestroyed();
      if (
        !cap.canPushSnapshots ||
        !signingKey ||
        !readKey
      ) {
        return;
      }
      const plaintext = subdocManager.encodeAll();
      const clockSum = this.clockSum;
      const { cid, block } = await snapshotLC.push(
        plaintext,
        readKey,
        signingKey,
        clockSum,
      );

      checkStatus();
      emit("snapshot-applied");

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
      const relayList: RelayDiagnostic[] = [];
      let gossipsub: GossipSubDiagnostic = {
        peers: 0,
        topics: 0,
        meshPeers: 0,
      };

      try {
        const helia = getHelia();
        const libp2p = (helia as any).libp2p;
        ipfsPeers = libp2p.getPeers().length;

        const knownRelays =
          params.roomDiscovery?.relayPeerIds
            ?? new Set<string>();
        if (knownRelays.size > 0) {
          const connectedPids = new Set<string>();
          for (const conn of libp2p.getConnections()) {
            connectedPids.add(
              (conn as any).remotePeer.toString(),
            );
          }
          for (const pid of knownRelays) {
            relayList.push({
              peerId: pid,
              short: pid.slice(-8),
              connected: connectedPids.has(pid),
            });
          }
        }

        try {
          const pubsub = libp2p.services.pubsub;
          const topics: string[] =
            pubsub.getTopics?.() ?? [];
          const gsPeers = pubsub.getPeers?.() ?? [];
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
        relays: relayList,
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
          snapshotWatcher?.hasAppliedSnapshot ?? false,
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
      const pubsub =
        getHeliaPubsub() as unknown as PubSubLike;

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
      const pubsub =
        getHeliaPubsub() as unknown as PubSubLike;

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
