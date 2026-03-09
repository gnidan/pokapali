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
} from "./snapshot-watcher.js";
import {
  createRelaySharing,
} from "./relay-sharing.js";
import type {
  RelaySharing,
} from "./relay-sharing.js";

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

export interface RotateResult {
  newDoc: CollabDoc;
  forwardingRecord: Uint8Array;
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
  pushSnapshot(): Promise<void>;
  rotate(): Promise<RotateResult>;
  on(
    event: "status",
    cb: (status: DocStatus) => void,
  ): void;
  on(event: "snapshot-recommended", cb: () => void): void;
  on(event: "snapshot-applied", cb: () => void): void;
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

  subdocManager.on("dirty", () => {
    checkStatus();
    emit("snapshot-recommended");
  });

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
    console.log(
      "[pokapali] announce setup: pubsub=" +
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
          emit("snapshot-applied");
        }
      },
    });

    // Writers start re-announce
    if (cap.canPushSnapshots) {
      snapshotWatcher.startReannounce(
        () => snapshotLC.prev,
        (cidStr) => snapshotLC.getBlock(cidStr),
      );
    }
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
    },

    get ipnsSeq(): number | null {
      return snapshotLC.lastIpnsSeq;
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
      console.log(
        "[pokapali] pushSnapshot: cid=" +
          cidShort + "... clockSum=" + clockSum,
      );
      (async () => {
        const helia = getHelia();
        console.log(
          "[pokapali] blockstore.put...",
          cidShort + "...",
        );
        await Promise.resolve(
          helia.blockstore.put(cid, block),
        );
        console.log(
          "[pokapali] blockstore.put done,"
            + " publishing IPNS...",
        );
        await publishIPNS(
          helia, keys.ipnsKeyBytes!, cid,
          clockSum,
        );
        console.log(
          "[pokapali] IPNS published, announcing...",
        );
        if (params.appId && params.pubsub) {
          await announceSnapshot(
            params.pubsub as any,
            params.appId,
            ipnsName,
            cid.toString(),
          );
          console.log(
            "[pokapali] announce sent",
          );
        }
      })().catch((err: unknown) => {
        console.error(
          "[pokapali] IPNS publish/announce failed:",
          err,
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
      destroyed = true;
      relaySharing?.destroy();
      snapshotWatcher?.destroy();
      params.roomDiscovery?.stop();
      syncManager.destroy();
      awarenessRoom.destroy();
      subdocManager.destroy();
      releaseHelia();

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
      destroyed = true;
      relaySharing?.destroy();
      snapshotWatcher?.destroy();
      params.roomDiscovery?.stop();
      syncManager.destroy();
      awarenessRoom.destroy();
      subdocManager.destroy();
      releaseHelia();
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
