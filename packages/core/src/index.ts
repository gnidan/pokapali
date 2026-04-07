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
import {
  setupNamespaceRooms,
  setupSignaledAwarenessRoom,
  createSignalingClient,
  SIGNALING_PROTOCOL,
} from "@pokapali/sync";
import type {
  SyncOptions,
  PubSubLike,
  SignalingStream,
  AwarenessRoom,
} from "@pokapali/sync";
import {
  lookupForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import { ValidationError } from "./errors.js";
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
import { createLogger } from "@pokapali/log";
import { createDoc, populateMeta } from "./create-doc.js";
import type { Doc } from "./create-doc.js";
import { loadIdentity } from "./identity.js";
import { Document } from "@pokapali/document";
import { yjsCodec } from "@pokapali/codec";
import { Store } from "@pokapali/store";

const log = createLogger("core");

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Configuration for a pokapali application instance.
 * Passed to {@link pokapali} to create an app that
 * can create and open collaborative documents.
 */
export interface PokapaliConfig {
  /**
   * Application identifier. Documents created by
   * different appIds are independent even on the
   * same origin. Defaults to `""`.
   */
  appId?: string;
  /**
   * Network identifier. Isolates GossipSub topics
   * and signaling rooms so test and production
   * traffic never cross. Defaults to `"main"`.
   */
  networkId?: string;
  /** Named channels for this app's documents.
   *  At least one is required. */
  channels: string[];
  /** Channel to treat as the primary document
   *  content. Defaults to the first channel. */
  primaryChannel?: string;
  /** Base URL for capability links (e.g.
   *  `https://example.com`). Used to build
   *  shareable document URLs. */
  origin: string;
  /** Additional WebSocket signaling server URLs.
   *  Empty by default — signaling uses GossipSub
   *  via libp2p. */
  signalingUrls?: string[];
  /** Override libp2p bootstrap peer multiaddrs.
   *  Rarely needed. */
  bootstrapPeers?: string[];
  /** WebRTC peer connection options passed to
   *  simple-peer (e.g. custom ICE servers). */
  rtc?: SyncOptions["peerOpts"];
  /**
   * Enable P2P networking (Helia, WebRTC, relay
   * discovery). Defaults to true. Set to false for
   * solo/offline mode — useful for E2E UI tests
   * that don't need multi-peer sync.
   */
  p2p?: boolean;
}

/**
 * A configured pokapali application. Use
 * {@link create} to make a new document or
 * {@link open} to join an existing one via URL.
 */
export interface PokapaliApp {
  /** Creates a new document with admin access. */
  create(): Promise<Doc>;
  /** Opens an existing document from a capability
   *  URL. The URL's fragment determines the access
   *  level (admin, write, or read). */
  open(url: string): Promise<Doc>;
  /** Check if a URL matches this app's doc format. */
  isDocUrl(url: string): boolean;
  /** Extracts the document's IPNS name from a
   *  capability URL. */
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
  /** Called after metaDoc + surfaces are created
   *  but before createDoc (e.g. populateMeta). */
  afterSubdocSetup?: (metaDoc: import("yjs").Doc) => void;
}

/**
 * Creates a pokapali application instance. This is
 * the main entry point for the library.
 *
 * @param options - Application configuration.
 * @returns A {@link PokapaliApp} that can create
 *   and open collaborative documents.
 * @throws In non-browser environments. Use
 *   `@pokapali/node` for Node.js.
 */
export function pokapali(options: PokapaliConfig): PokapaliApp {
  if (typeof window === "undefined") {
    throw new Error(
      "@pokapali/core requires a browser environment." +
        " For Node.js, use @pokapali/node instead.",
    );
  }

  const { channels, origin } = options;
  const appId = options.appId ?? "";
  const networkId = options.networkId ?? "main";
  const primaryChannel = options.primaryChannel ?? channels[0] ?? "";
  const signalingUrls = options.signalingUrls ?? [];
  const bootstrapPeers = options.bootstrapPeers;
  const p2pEnabled = options.p2p !== false;

  // Store — created once, cached for app lifetime.
  let storePromise: Promise<Store> | null = null;
  function getStore(): Promise<Store> {
    if (!storePromise) {
      storePromise = Store.create(appId);
    }
    return storePromise;
  }

  // Identity keypair — loaded once, cached for app
  // lifetime. Always present (identity is always-on).
  let identityPromise: Promise<Ed25519KeyPair> | null = null;
  function getIdentity(): Promise<Ed25519KeyPair> {
    if (!identityPromise) {
      identityPromise = getStore().then((s) => loadIdentity(s.identity));
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
    const store = await getStore();
    const storeDoc = store.documents.get(ipnsName);

    const cap = inferCapability(keys, channels);
    const chKeys = keys.channelKeys ?? {};

    // Standalone metaDoc for auth state and
    // client identity.
    const metaDoc = new Y.Doc({
      guid: `${ipnsName}:_meta`,
      gc: true,
    });

    // Create Document + eagerly create surfaces so
    // surface Y.Docs are available for Store replay.
    const document = Document.create({
      identity: {
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(64),
      },
      capability: {
        channels: new Set(channels),
        canPushSnapshots: false,
        isAdmin: false,
      },
      codec: yjsCodec,
    });

    // Eagerly create a surface per channel —
    // the surface Y.Docs become the editing
    // substrate.
    for (const ch of channels) {
      document.surface(ch, { guid: `${ipnsName}:${ch}` });
    }

    init.afterSubdocSetup?.(metaDoc);

    // Standalone awareness — available immediately
    // before Helia/WebRTC connects. Passed to
    // setupSignaledAwarenessRoom once a relay is
    // discovered.
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
    // When p2p is disabled, skip entirely — doc
    // operates in local-only mode.
    const p2pReady = !p2pEnabled
      ? undefined
      : (async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let blockstore: any;
          if (!isHeliaLive()) {
            const { IDBBlockstore } = await import("blockstore-idb");
            const bs = new IDBBlockstore(`pokapali:blocks:${appId}`);
            await bs.open();
            blockstore = bs;
          }

          await acquireHelia({
            bootstrapPeers,
            blockstore,
            networkId,
          });

          try {
            const pubsub = getHeliaPubsub() as unknown as PubSubLike;
            acquireNodeRegistry(pubsub, () => getHelia(), networkId);

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
              chKeys,
              signalingUrls,
              syncOpts,
            );

            const helia = getHelia();

            const roomDiscovery = startRoomDiscovery(helia, appId);

            // Bootstrap peers are dialed by libp2p but
            // peer-discovery doesn't know they're relays.
            // Feed them as external relays so they get
            // tracked in relayPeerIds.
            if (bootstrapPeers?.length) {
              const entries = bootstrapPeers
                .map((addr) => {
                  const m = addr.match(/\/p2p\/([^/]+)$/);
                  return m ? { peerId: m[1], addrs: [addr] } : null;
                })
                .filter(
                  (e): e is { peerId: string; addrs: string[] } => e !== null,
                );
              if (entries.length > 0) {
                roomDiscovery.addExternalRelays(entries);
              }
            }

            // Wait for relay discovery, then open a
            // signaling stream for WebRTC peer discovery.
            // If the initial wait times out, resolve with
            // a placeholder and retry signaling in the
            // background — relays often connect after the
            // DHT finishes its slow initial lookup.
            const RELAY_WAIT_MS = 30_000;
            const RETRY_RELAY_WAIT_MS = 120_000;

            log.info("waiting for relay discovery...");

            let awarenessRoom: AwarenessRoom;
            let upgradeAwareness: Promise<AwarenessRoom> | undefined;
            try {
              const relayPid = await roomDiscovery.waitForRelay(RELAY_WAIT_MS);

              log.info("relay discovered:", relayPid.slice(0, 12));
              awarenessRoom = await trySignaling(
                helia,
                relayPid,
                ipnsName,
                awareness,
                syncOpts,
                networkId,
              );
            } catch (err) {
              log.warn(
                "signaling setup failed, retrying in bg:",
                (err as Error)?.message ?? err,
              );
              awarenessRoom = placeholderAwarenessRoom(awareness);
              upgradeAwareness = retrySignaling(
                helia,
                roomDiscovery,
                ipnsName,
                awareness,
                syncOpts,
                networkId,
                RETRY_RELAY_WAIT_MS,
              );
              // Prevent unhandled-rejection if createDoc
              // hasn't attached its handler yet.
              upgradeAwareness.catch(() => {});
            }

            return {
              pubsub,
              syncManager,
              awarenessRoom,
              roomDiscovery,
              upgradeAwareness,
            };
          } catch (err) {
            releaseHelia();
            throw err;
          }
        })();

    return createDoc({
      awareness,
      p2pReady,
      codec: yjsCodec,
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
      networkId,
      primaryChannel,
      signalingUrls,
      performInitialResolve: init.performInitialResolve,
      identity,
      document,
      metaDoc,
      storeDocument: storeDoc,
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
            throw new ValidationError(
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

export { App } from "./app.js";
export type { AppConfig } from "./app.js";

// --- Signaling helper ---

async function trySignaling(
  helia: ReturnType<typeof getHelia>,
  relayPid: string,
  ipnsName: string,
  awareness: Awareness,
  syncOpts: SyncOptions,
  networkId: string,
): Promise<AwarenessRoom> {
  const localPeerId = helia.libp2p.peerId.toString();
  const conn = helia.libp2p
    .getConnections()
    .find((c) => c.remotePeer.toString() === relayPid);
  if (!conn) {
    throw new Error("relay connection lost: " + relayPid.slice(0, 12));
  }

  log.info("opening signaling stream to:", relayPid.slice(0, 12));
  const stream = await helia.libp2p.dialProtocol(
    conn.remotePeer,
    SIGNALING_PROTOCOL,
  );

  const client = createSignalingClient(stream as unknown as SignalingStream);
  log.info("signaling connected to relay:", relayPid.slice(0, 12));

  const rtcConfig = syncOpts.peerOpts?.config;
  return setupSignaledAwarenessRoom(ipnsName, localPeerId, client, awareness, {
    rtcConfig,
    networkId,
  });
}

// --- Placeholder awareness room ---

/**
 * Minimal AwarenessRoom used while waiting for a
 * late relay to connect. Does nothing except hold
 * the awareness instance.
 */
function placeholderAwarenessRoom(awareness: Awareness): AwarenessRoom {
  return {
    get awareness() {
      return awareness;
    },
    get connected() {
      return false;
    },
    onStatusChange() {},
    onPeerCreated() {
      return () => {};
    },
    onPeerConnection() {
      return () => {};
    },
    destroy() {},
  };
}

/**
 * Keep watching for relay connections and retry
 * signaling setup. Resolves when signaling succeeds;
 * rejects only if a hard timeout expires.
 */
async function retrySignaling(
  helia: ReturnType<typeof getHelia>,
  roomDiscovery: ReturnType<typeof startRoomDiscovery>,
  ipnsName: string,
  awareness: Awareness,
  syncOpts: SyncOptions,
  networkId: string,
  retryTimeoutMs: number,
): Promise<AwarenessRoom> {
  const deadline = Date.now() + retryTimeoutMs;
  const tried = new Set<string>();

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let relayPid: string;
    try {
      relayPid = await roomDiscovery.waitForRelay(remaining);
    } catch {
      break;
    }

    // Try each tracked relay, not just the first
    const relays = [...roomDiscovery.relayPeerIds];
    for (const pid of relays) {
      if (tried.has(pid)) continue;
      tried.add(pid);

      try {
        log.info("trying signaling to late relay:", pid.slice(0, 12));
        const room = await trySignaling(
          helia,
          pid,
          ipnsName,
          awareness,
          syncOpts,
          networkId,
        );
        log.info("signaling upgraded via late relay");
        return room;
      } catch (err) {
        log.debug(
          "signaling retry failed for",
          pid.slice(0, 12) + ":",
          (err as Error)?.message ?? err,
        );
      }
    }

    // All known relays tried — wait for new ones.
    tried.clear();
    await new Promise((r) => setTimeout(r, 10_000));
  }

  throw new Error(
    "signaling retry timed out after " + `${retryTimeoutMs / 1000}s`,
  );
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
  CapabilityEdge,
  TopologyNode,
  TopologyEdge,
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
export { NODE_CAPS_TOPIC, nodeCapsTopic } from "./node-registry.js";
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
export type { Awareness } from "y-protocols/awareness";

export {
  PokapaliError,
  PermissionError,
  TimeoutError,
  DestroyedError,
  ValidationError,
  NotFoundError,
} from "./errors.js";
export { SnapshotValidationError } from "./snapshot-ops.js";
