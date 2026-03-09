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
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  walkChain,
} from "@pokapali/snapshot";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
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
  resolveIPNS,
  watchIPNS,
} from "./ipns-helpers.js";
import {
  announceSnapshot,
  announceTopic,
  parseAnnouncement,
} from "./announce.js";
import {
  startRoomDiscovery,
} from "./peer-discovery.js";
import type { RoomDiscovery } from "./peer-discovery.js";

const DAG_CBOR_CODE = 0x71;

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

const FETCH_RETRIES = 6;
const FETCH_BASE_MS = 2_000;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchBlock(
  helia: { blockstore: { get(cid: CID, opts?: any): any } },
  cid: CID,
): Promise<Uint8Array> {
  for (let i = 0; i <= FETCH_RETRIES; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        FETCH_TIMEOUT_MS,
      );
      try {
        const block: Uint8Array = await helia
          .blockstore.get(cid, {
            signal: ctrl.signal,
          });
        return block;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (i === FETCH_RETRIES) throw err;
      const delay = FETCH_BASE_MS * 2 ** i;
      console.log(
        `[pokapali] block fetch retry` +
          ` ${i + 1}/${FETCH_RETRIES}` +
          ` in ${delay}ms for`,
        cid.toString().slice(0, 16) + "...",
      );
      await new Promise(
        (r) => setTimeout(r, delay),
      );
    }
  }
  throw new Error("unreachable");
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
  let seq = 1;
  let prev: CID | null = null;
  const blocks = new Map<string, Uint8Array>();
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
  // Periodically publish our known relays and consume
  // relays from other peers.
  let relayShareTimer: ReturnType<
    typeof setInterval
  > | null = null;
  if (params.roomDiscovery) {
    const rd = params.roomDiscovery;
    const awareness = awarenessRoom.awareness;

    // Publish our relay entries into awareness
    const publishRelays = () => {
      const entries = rd.relayEntries();
      if (entries.length > 0) {
        awareness.setLocalStateField(
          "relays",
          entries,
        );
      }
    };

    // Consume relay entries from other peers
    const onAwarenessUpdate = () => {
      const states = awareness.getStates();
      for (const [clientId, state] of states) {
        if (clientId === awareness.clientID) continue;
        const relays = state?.relays;
        if (Array.isArray(relays) && relays.length > 0) {
          rd.addExternalRelays(relays);
        }
      }
    };

    awareness.on("update", onAwarenessUpdate);

    // Publish every 30s (relays may be discovered
    // after initial awareness sync)
    relayShareTimer = setInterval(
      publishRelays,
      30_000,
    );
    // Initial publish after a short delay to let
    // discovery run first
    setTimeout(publishRelays, 5_000);
  }

  // Periodic re-announce for writers so pinners
  // that join later learn about existing snapshots.
  const REANNOUNCE_MS = 30_000;
  let announceTimer: ReturnType<
    typeof setInterval
  > | null = null;
  if (
    cap.canPushSnapshots &&
    params.appId &&
    params.pubsub
  ) {
    const ps = params.pubsub;
    // Subscribe so writer joins the GossipSub mesh
    // for the announce topic (needed for relay
    // forwarding to readers).
    ps.subscribe(announceTopic(params.appId));
    announceTimer = setInterval(() => {
      if (prev) {
        // Re-put the block so pinners can fetch it
        const cidStr = prev.toString();
        const block = blocks.get(cidStr);
        if (block) {
          const helia = getHelia();
          Promise.resolve(
            helia.blockstore.put(prev, block),
          ).catch(() => {});
        }
        announceSnapshot(
          ps as any,
          params.appId,
          ipnsName,
          cidStr,
        );
      }
    }, REANNOUNCE_MS);
  }

  // Read-only watchers: listen for announcements +
  // poll IPNS as fallback
  const isReadOnly =
    !keys.namespaceKeys ||
    Object.keys(keys.namespaceKeys).length === 0;
  let stopWatch: (() => void) | null = null;
  let announceHandler: ((evt: CustomEvent) => void)
    | null = null;
  let retryTimer: ReturnType<typeof setTimeout>
    | null = null;
  if (isReadOnly && readKey) {
    const pubKeyBytes = hexToBytes(ipnsName);
    const rk = readKey;
    let lastAppliedCid: string | null = null;
    let pendingCid: string | null = null;
    const RETRY_INTERVAL_MS = 30_000;

    async function applySnapshotFromCID(
      cid: CID,
    ): Promise<void> {
      const cidStr = cid.toString();
      if (cidStr === lastAppliedCid) return;
      const helia = getHelia();
      const block = await fetchBlock(helia, cid);
      blocks.set(cidStr, block);
      const node = decodeSnapshot(block);
      const plaintext =
        await decryptSnapshot(node, rk);
      subdocManager.applySnapshot(plaintext);
      lastAppliedCid = cidStr;
      // Clear pending since we succeeded
      if (pendingCid === cidStr) pendingCid = null;
      emit("snapshot-applied");
    }

    function scheduleRetry() {
      if (retryTimer || !pendingCid) return;
      retryTimer = setTimeout(async () => {
        retryTimer = null;
        if (!pendingCid || destroyed) return;
        const cidStr = pendingCid;
        console.log(
          "[pokapali] retrying fetch for",
          cidStr.slice(0, 16) + "...",
        );
        try {
          await applySnapshotFromCID(
            CID.parse(cidStr),
          );
        } catch {
          // Still failing — keep retrying
          scheduleRetry();
        }
      }, RETRY_INTERVAL_MS);
    }

    // Listen for GossipSub announcements (instant)
    if (params.pubsub && params.appId) {
      const topic = announceTopic(params.appId);
      params.pubsub.subscribe(topic);
      announceHandler = (evt: CustomEvent) => {
        const { detail } = evt;
        if (detail?.topic !== topic) return;
        const ann = parseAnnouncement(detail.data);
        if (!ann || ann.ipnsName !== ipnsName) return;
        console.log(
          "[pokapali] announce received:",
          ann.cid.slice(0, 16) + "...",
        );
        const cid = CID.parse(ann.cid);
        // Track as pending (latest announced CID)
        pendingCid = ann.cid;
        applySnapshotFromCID(cid).catch((err) => {
          console.error(
            "[pokapali] announce apply failed:",
            err,
          );
          // Schedule persistent retry
          scheduleRetry();
        });
      };
      params.pubsub.addEventListener(
        "message",
        announceHandler,
      );
    }

    // IPNS polling fallback (for when no GossipSub
    // peers are connected)
    stopWatch = watchIPNS(
      getHelia(),
      pubKeyBytes,
      async (cid) => {
        try {
          pendingCid = cid.toString();
          await applySnapshotFromCID(cid);
        } catch {
          // Best-effort — retry loop will pick it up
          scheduleRetry();
        }
      },
    );
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
      const block = await encodeSnapshot(
        plaintext,
        readKey,
        prev,
        seq,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(DAG_CBOR_CODE, hash);
      blocks.set(cid.toString(), block);

      // Compute IPNS seq from Y.Doc state vector
      // clock sum. Deterministic: same doc state →
      // same seq, so cross-browser races produce
      // identical IPNS records instead of conflicting.
      let clockSum = 0;
      for (const ns of namespaces) {
        const sv = Y.encodeStateVector(
          subdocManager.subdoc(ns),
        );
        const decoded = Y.decodeStateVector(sv);
        for (const clock of decoded.values()) {
          clockSum += clock;
        }
      }

      prev = cid;
      seq++;
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
      if (relayShareTimer) {
        clearInterval(relayShareTimer);
      }
      if (announceTimer) {
        clearInterval(announceTimer);
      }
      if (stopWatch) {
        stopWatch();
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (announceHandler && params.pubsub) {
        params.pubsub.removeEventListener(
          "message",
          announceHandler,
        );
      }
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
      if (!prev) return [];

      const getter = async (cid: CID) => {
        const block = blocks.get(cid.toString());
        if (!block) {
          throw new Error(
            "Block not found: " + cid.toString(),
          );
        }
        return block;
      };

      const entries: Array<{
        cid: CID;
        seq: number;
        ts: number;
      }> = [];
      let currentCid: CID | null = prev;
      for await (const node of walkChain(
        prev,
        getter,
      )) {
        entries.push({
          cid: currentCid!,
          seq: node.seq,
          ts: node.ts,
        });
        currentCid = node.prev;
      }
      return entries;
    },

    async loadVersion(cid: CID) {
      assertNotDestroyed();
      let block = blocks.get(cid.toString());
      if (!block) {
        // Fall back to Helia blockstore
        try {
          const helia = getHelia();
          block = await helia.blockstore.get(cid);
        } catch {
          throw new Error(
            "Unknown CID: " + cid.toString(),
          );
        }
      }
      if (!readKey) {
        throw new Error("No readKey available");
      }
      const node = decodeSnapshot(block);
      const plaintext = await decryptSnapshot(
        node,
        readKey,
      );
      const result: Record<string, Y.Doc> = {};
      for (const [ns, bytes] of Object.entries(
        plaintext,
      )) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        result[ns] = doc;
      }
      return result;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (relayShareTimer) {
        clearInterval(relayShareTimer);
      }
      if (announceTimer) {
        clearInterval(announceTimer);
      }
      if (stopWatch) {
        stopWatch();
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (announceHandler && params.pubsub) {
        params.pubsub.removeEventListener(
          "message",
          announceHandler,
        );
      }
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

      // Read-only: resolve IPNS to load initial
      // snapshot from the network. Non-blocking so
      // the doc opens immediately for WebRTC sync.
      const isReadOnly =
        !keys.namespaceKeys ||
        Object.keys(keys.namespaceKeys).length === 0;
      const readOnlyResolve =
        isReadOnly && keys.readKey
          ? (async () => {
              try {
                const pubKeyBytes =
                  hexToBytes(ipnsName);
                const helia = getHelia();
                const tipCid = await resolveIPNS(
                  helia,
                  pubKeyBytes,
                );
                if (tipCid) {
                  console.log(
                    "[pokapali] IPNS resolved:",
                    tipCid.toString(),
                  );
                  const block =
                    await fetchBlock(helia, tipCid);
                  const node = decodeSnapshot(block);
                  const rk = keys.readKey!;
                  const plaintext =
                    await decryptSnapshot(node, rk);
                  subdocManager.applySnapshot(plaintext);
                  console.log(
                    "[pokapali] initial snapshot applied",
                  );
                } else {
                  console.log(
                    "[pokapali] IPNS resolve returned" +
                      " null",
                  );
                }
              } catch (err) {
                console.error(
                  "[pokapali] initial snapshot" +
                    " load failed:",
                  err,
                );
              }
            })()
          : undefined;

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
