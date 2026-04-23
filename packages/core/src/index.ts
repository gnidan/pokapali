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
  deriveMetaChannelKey,
  ed25519KeyPairFromSeed,
  bytesToHex,
} from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { SyncOptions } from "@pokapali/sync";
import { createMultiRelayRoom } from "@pokapali/sync";
import {
  lookupForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import { ValidationError } from "./errors.js";
import { docIdFromUrl } from "./url-utils.js";
import { createDoc } from "./create-doc.js";
import type { Doc } from "./create-doc.js";
import { loadIdentity } from "./identity.js";
import { Document } from "@pokapali/document";
import { yjsCodec } from "@pokapali/codec";
import { Store } from "@pokapali/store";
import { setupP2PLayer } from "./p2p-layer.js";
import type { BlockResolver, BlockResolverOptions } from "./block-resolver.js";

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
  /**
   * Factory for creating a BlockResolver per doc.
   * Called with `{ getHelia, httpUrls }` — the
   * persistence callbacks (onWriteError) are wired
   * internally by createDoc.
   *
   * When omitted, createDoc uses core's built-in
   * resolver (unbounded memory cache, memory-only
   * `has()`).
   *
   * For production, pass a wrapper around
   * `createDocBlockResolver` from
   * `@pokapali/protocol`:
   * ```ts
   * createResolver: (opts) =>
   *   createDocBlockResolver({ ...opts })
   * ```
   */
  createResolver?: (opts: BlockResolverOptions) => BlockResolver;
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

  const { channels: appChannels, origin } = options;
  // Library prepends _meta — a synced channel for
  // document metadata (title, client identities).
  const channels = ["_meta", ...appChannels];
  const appId = options.appId ?? "";
  const networkId = options.networkId ?? "main";
  const primaryChannel = options.primaryChannel ?? appChannels[0] ?? "";
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
    await store.migrated;
    const storeDoc = store.documents.get(ipnsName);

    // Infer capability from app-level channels only.
    // _meta is always accessible — it's library infra.
    const cap = inferCapability(keys, appChannels);
    const chKeys = keys.channelKeys ?? {};

    // Backfill _meta channel key for pre-A2 docs.
    // Derives deterministically from readKey so all
    // peers get the same key.
    if (!chKeys._meta && keys.readKey) {
      const metaKey = await deriveMetaChannelKey(keys.readKey);
      chKeys._meta = metaKey;
      if (!keys.channelKeys) {
        keys.channelKeys = {};
      }
      keys.channelKeys._meta = metaKey;
    }

    // Create Document + eagerly create surfaces so
    // surface Y.Docs are available for Store replay.
    // _meta is included in channels — it gets a
    // surface just like app-defined channels.
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
            channels: [...(chKeys._meta ? ["_meta"] : []), ...cap.channels],
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
    //
    // Create the multiRoom early so createDoc can
    // register onPeerCreated BEFORE any relay
    // connects. This avoids the race where peers
    // join during trySignaling and fire
    // onPeerCreated before the consumer callback
    // is registered.
    const multiRoom = p2pEnabled ? createMultiRelayRoom(awareness) : undefined;

    const p2pReady = !p2pEnabled
      ? undefined
      : setupP2PLayer({
          appId,
          networkId,
          ipnsName,
          channelKeys: chKeys,
          signalingUrls,
          awareness,
          bootstrapPeers,
          rtcIceServers: options.rtc?.config?.iceServers,
          multiRoom,
        });

    return createDoc({
      awareness,
      awarenessRoom: multiRoom,
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
      storeDocument: storeDoc,
      createResolver: options.createResolver,
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
export type { CodecSurface } from "@pokapali/codec";
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
export type { BlockResolver, BlockResolverOptions } from "./block-resolver.js";
