import type { CapabilityKeys } from "@pokapali/capability";
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
  bytesToHex,
} from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { createSubdocManager } from "@pokapali/subdocs";
import { setupNamespaceRooms, setupAwarenessRoom } from "@pokapali/sync";
import type { SyncOptions, PubSubLike } from "@pokapali/sync";
import {
  lookupForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import {
  acquireHelia,
  releaseHelia,
  getHeliaPubsub,
  getHelia,
  isHeliaLive,
} from "./helia.js";
import { acquireNodeRegistry } from "./node-registry.js";
import { startRoomDiscovery } from "./peer-discovery.js";
import { docIdFromUrl } from "./url-utils.js";
import { createDoc, populateMeta } from "./create-doc.js";
import type { Doc } from "./create-doc.js";
import { createDocPersistence } from "./persistence.js";
import type { DocPersistence } from "./persistence.js";
import { loadIdentity } from "./identity.js";

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
  /**
   * Enable IndexedDB persistence for Yjs state and
   * IPFS blocks. Defaults to true. Set to false to
   * disable (e.g. for cold-start testing via
   * ?noCache=1).
   */
  persistence?: boolean;
}

export interface PokapaliApp {
  create(): Promise<Doc>;
  open(url: string): Promise<Doc>;
  /** Check if a URL matches this app's doc format. */
  isDocUrl(url: string): boolean;
  docIdFromUrl(url: string): string;
}

/** Intermediate shape produced by create() and
 *  open() before the shared init path. */
interface DocInit {
  ipnsName: string;
  keys: CapabilityKeys;
  signingKey: Ed25519KeyPair | null;
  identity: Ed25519KeyPair;
  /** True for open() — triggers IPNS resolution. */
  performInitialResolve: boolean;
  /** True when IDB cache may exist (open only). */
  hasCachedState: boolean;
  /** Called after subdocManager is created but
   *  before createDoc (e.g. populateMeta). */
  afterSubdocSetup?: (metaDoc: import("yjs").Doc) => void;
}

export function pokapali(options: PokapaliConfig): PokapaliApp {
  const { channels, origin } = options;
  const appId = options.appId ?? "";
  const primaryChannel = options.primaryChannel ?? channels[0];
  const signalingUrls = options.signalingUrls ?? [];
  const bootstrapPeers = options.bootstrapPeers;
  const persistenceEnabled = options.persistence !== false;

  // Identity keypair — loaded once, cached for app
  // lifetime. Always present (identity is always-on).
  let identityPromise: Promise<Ed25519KeyPair> | null = null;
  function getIdentity(): Promise<Ed25519KeyPair> {
    if (!identityPromise) {
      identityPromise = loadIdentity(appId);
    }
    return identityPromise;
  }

  /** Shared init path — both create() and open()
   *  produce a DocInit, then this does the rest.
   *
   *  Returns the Doc immediately. Helia bootstrap
   *  and P2P layer setup run in the background via
   *  p2pReady. */
  async function initDoc(init: DocInit): Promise<Doc> {
    const { ipnsName, keys, signingKey, identity } = init;

    const cap = inferCapability(keys, channels);
    const chKeys = keys.channelKeys ?? {};

    // Layer A: y-indexeddb persistence per subdoc
    let docPersistence: DocPersistence | null = null;
    const skipOrigins = new Set<object>();

    const subdocManager = createSubdocManager(ipnsName, channels, {
      primaryNamespace: primaryChannel,
      skipOrigins: persistenceEnabled ? skipOrigins : undefined,
    });

    if (persistenceEnabled) {
      docPersistence = createDocPersistence(subdocManager, channels);
      for (const p of docPersistence.providers) {
        skipOrigins.add(p);
      }
    }

    init.afterSubdocSetup?.(subdocManager.metaDoc);

    // Standalone awareness — available immediately
    // before Helia/WebRTC connects. Passed to the
    // WebrtcProvider later via setupAwarenessRoom.
    const awarenessDummyDoc = new Y.Doc();
    const awareness = new Awareness(awarenessDummyDoc);

    const adminUrl = keys.rotationKey
      ? await buildUrl(origin, ipnsName, keys)
      : null;
    const writeUrl = keys.ipnsKeyBytes
      ? await buildUrl(
          origin,
          ipnsName,
          narrowCapability(keys, {
            channels: [...cap.channels],
            canPushSnapshots: true,
          }),
        )
      : null;
    const readUrl = await buildUrl(
      origin,
      ipnsName,
      narrowCapability(keys, {
        channels: [],
      }),
    );

    // Layer B: Helia + P2P — runs in background.
    const p2pReady = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let blockstore: any;
      if (persistenceEnabled && !isHeliaLive()) {
        const { IDBBlockstore } = await import("blockstore-idb");
        const bs = new IDBBlockstore(`pokapali:blocks:${appId}`);
        await bs.open();
        blockstore = bs;
        if (docPersistence) {
          const bsRef = bs;
          docPersistence.closeBlockstore = () => bsRef.close();
        }
      }
      await acquireHelia({ bootstrapPeers, blockstore });

      try {
        const pubsub = getHeliaPubsub() as unknown as PubSubLike;
        acquireNodeRegistry(pubsub, () => getHelia());

        const userIce = options.rtc?.config?.iceServers;
        const syncOpts: SyncOptions = {
          peerOpts: {
            config: {
              iceServers: userIce ?? DEFAULT_ICE_SERVERS,
            },
          },
          pubsub,
        };

        const syncManager = setupNamespaceRooms(
          ipnsName,
          subdocManager,
          chKeys,
          signalingUrls,
          syncOpts,
        );

        const awarenessRoom = setupAwarenessRoom(
          ipnsName,
          keys.awarenessRoomPassword ?? "",
          signalingUrls,
          syncOpts,
          awareness,
        );

        const roomDiscovery = startRoomDiscovery(getHelia(), appId);

        return {
          pubsub,
          syncManager,
          awarenessRoom,
          roomDiscovery,
        };
      } catch (err) {
        releaseHelia();
        throw err;
      }
    })();

    return createDoc({
      subdocManager,
      awareness,
      p2pReady,
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
      performInitialResolve: init.performInitialResolve,
      persistence: docPersistence,
      hasCachedState: init.hasCachedState,
      identity,
    });
  }

  return {
    async create(): Promise<Doc> {
      const identity = await getIdentity();

      const adminSecret = generateAdminSecret();
      const docKeys = await deriveDocKeys(adminSecret, appId, channels);

      const signingKey = await ed25519KeyPairFromSeed(docKeys.ipnsKeyBytes);
      const ipnsName = bytesToHex(signingKey.publicKey);

      const fullKeys: CapabilityKeys = {
        readKey: docKeys.readKey,
        ipnsKeyBytes: docKeys.ipnsKeyBytes,
        rotationKey: docKeys.rotationKey,
        awarenessRoomPassword: docKeys.awarenessRoomPassword,
        channelKeys: docKeys.channelKeys,
      };

      return initDoc({
        ipnsName,
        keys: fullKeys,
        signingKey,
        identity,
        performInitialResolve: false,
        hasCachedState: false,
        afterSubdocSetup: (metaDoc) => {
          populateMeta(metaDoc, signingKey.publicKey, docKeys.channelKeys);
        },
      });
    },

    async open(url: string): Promise<Doc> {
      const parsed = await parseUrl(url);
      const { ipnsName, keys } = parsed;

      // Check for forwarding record
      const fwdBytes = lookupForwardingRecord(ipnsName);
      if (fwdBytes) {
        const fwd = decodeForwardingRecord(fwdBytes);
        if (keys.rotationKey) {
          const valid = await verifyForwardingRecord(fwd, keys.rotationKey);
          if (!valid) {
            throw new Error(
              "Invalid forwarding record signature" +
                " — the document may have been" +
                " rotated with a different key," +
                " or the forwarding record is" +
                " corrupted. Try using a freshly" +
                " shared URL",
            );
          }
        }
        return this.open(fwd.newUrl);
      }

      const identity = await getIdentity();

      let signingKey: Ed25519KeyPair | null = null;
      if (keys.ipnsKeyBytes) {
        signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
      }

      return initDoc({
        ipnsName,
        keys,
        signingKey,
        identity,
        performInitialResolve: !!keys.readKey,
        hasCachedState: persistenceEnabled,
      });
    },

    isDocUrl(url: string): boolean {
      try {
        const parsed = new URL(url);
        const prefix = origin.replace(/\/$/, "") + "/doc/";
        const orig = new URL(prefix).origin;
        const path = new URL(prefix).pathname;
        return (
          parsed.origin === orig &&
          parsed.pathname.startsWith(path) &&
          parsed.hash.length > 1
        );
      } catch {
        return false;
      }
    },

    docIdFromUrl(url: string): string {
      return docIdFromUrl(url);
    },
  };
}

// --- Re-exports ---

export type {
  Doc,
  DocUrls,
  DocRole,
  DocStatus,
  SaveState,
  SnapshotEvent,
  VersionInfo,
  ParticipantInfo,
  ClientIdentityInfo,
} from "./create-doc.js";

export type { Feed } from "./feed.js";

export type { RotateResult } from "./doc-rotate.js";

export type {
  GossipActivity,
  LoadingState,
  VersionHistory,
  VersionHistoryEntry,
  VersionEntryStatus,
} from "./facts.js";

export { statusLabel, saveLabel } from "./doc-status.js";

export { fetchVersionHistory } from "./fetch-version-history.js";
export type { VersionEntry, VersionTier } from "./fetch-version-history.js";

export type {
  NodeInfo,
  GossipSubDiagnostic,
  Diagnostics,
} from "./doc-diagnostics.js";

export type {
  TopologyEdge,
  TopologyNode,
  TopologyGraphEdge,
  TopologyGraph,
} from "./topology-graph.js";

export {
  encodeForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
export type { ForwardingRecord } from "./forwarding.js";
export { createAutoSaver } from "./auto-save.js";
export type { AutoSaveOptions } from "./auto-save.js";
export { truncateUrl, docIdFromUrl } from "./url-utils.js";
export { NODE_CAPS_TOPIC, _resetNodeRegistry } from "./node-registry.js";
export type {
  KnownNode,
  Neighbor,
  NodeRegistry,
  NodeRegistryEvents,
} from "./node-registry.js";
export type {
  AwarenessTopology,
  AwarenessKnownNode,
} from "./topology-sharing.js";

export type { Capability, CapabilityGrant } from "@pokapali/capability";
