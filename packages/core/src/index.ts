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
} from "./helia.js";
import { acquireNodeRegistry } from "./node-registry.js";
import { startRoomDiscovery } from "./peer-discovery.js";
import { docIdFromUrl } from "./url-utils.js";
import { createDoc, populateMeta } from "./create-doc.js";
import type { Doc } from "./create-doc.js";

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

export interface PokapaliApp {
  create(): Promise<Doc>;
  open(url: string): Promise<Doc>;
  /** Check if a URL matches this app's doc format. */
  isDocUrl(url: string): boolean;
  docIdFromUrl(url: string): string;
}

export function pokapali(options: PokapaliConfig): PokapaliApp {
  const { channels, origin } = options;
  const appId = options.appId ?? "";
  const primaryChannel = options.primaryChannel ?? channels[0];
  const signalingUrls = options.signalingUrls ?? [];
  const bootstrapPeers = options.bootstrapPeers;

  return {
    async create(): Promise<Doc> {
      await acquireHelia({ bootstrapPeers });
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

        const adminSecret = generateAdminSecret();
        const docKeys = await deriveDocKeys(adminSecret, appId, channels);

        const signingKey = await ed25519KeyPairFromSeed(docKeys.ipnsKeyBytes);
        const ipnsName = bytesToHex(signingKey.publicKey);

        const subdocManager = createSubdocManager(ipnsName, channels, {
          primaryNamespace: primaryChannel,
        });

        const syncManager = setupNamespaceRooms(
          ipnsName,
          subdocManager,
          docKeys.channelKeys,
          signalingUrls,
          syncOpts,
        );

        const awarenessRoom = setupAwarenessRoom(
          ipnsName,
          docKeys.awarenessRoomPassword,
          signalingUrls,
          syncOpts,
        );

        const roomDiscovery = startRoomDiscovery(getHelia(), appId);

        const fullKeys: CapabilityKeys = {
          readKey: docKeys.readKey,
          ipnsKeyBytes: docKeys.ipnsKeyBytes,
          rotationKey: docKeys.rotationKey,
          awarenessRoomPassword: docKeys.awarenessRoomPassword,
          channelKeys: docKeys.channelKeys,
        };

        const adminUrl = await buildUrl(origin, ipnsName, fullKeys);
        const writeUrl = await buildUrl(
          origin,
          ipnsName,
          narrowCapability(fullKeys, {
            channels: [...channels],
            canPushSnapshots: true,
          }),
        );
        const readUrl = await buildUrl(
          origin,
          ipnsName,
          narrowCapability(fullKeys, {
            channels: [],
          }),
        );

        const cap = inferCapability(fullKeys, channels);

        populateMeta(
          subdocManager.metaDoc,
          signingKey.publicKey,
          docKeys.channelKeys,
        );

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
      const fwdBytes = lookupForwardingRecord(ipnsName);
      if (fwdBytes) {
        const fwd = decodeForwardingRecord(fwdBytes);
        if (keys.rotationKey) {
          const valid = await verifyForwardingRecord(fwd, keys.rotationKey);
          if (!valid) {
            throw new Error("Invalid forwarding record" + " signature");
          }
        }
        return this.open(fwd.newUrl);
      }

      await acquireHelia({ bootstrapPeers });
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

        const cap = inferCapability(keys, channels);

        const subdocManager = createSubdocManager(ipnsName, channels, {
          primaryNamespace: primaryChannel,
        });

        const chKeys = keys.channelKeys ?? {};
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
        );

        const roomDiscovery = startRoomDiscovery(getHelia(), appId);

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

        let signingKey: Ed25519KeyPair | null = null;
        if (keys.ipnsKeyBytes) {
          signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
        }

        return createDoc({
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
      } catch (err) {
        await releaseHelia();
        throw err;
      }
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
} from "./create-doc.js";

export type { RotateResult } from "./doc-rotate.js";

export type { GossipActivity, LoadingState } from "./snapshot-watcher.js";

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
