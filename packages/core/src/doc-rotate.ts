import * as Y from "yjs";
import { createLogger } from "@pokapali/log";
import { PermissionError } from "./errors.js";
import type { Capability, CapabilityKeys } from "@pokapali/capability";
import {
  inferCapability,
  narrowCapability,
  buildUrl,
} from "@pokapali/capability";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  bytesToHex,
} from "@pokapali/crypto";
import {
  setupNamespaceRooms,
  setupSignaledAwarenessRoom,
  createSignalingClient,
  SIGNALING_PROTOCOL,
} from "@pokapali/sync";
import type {
  SyncOptions,
  PubSubLike,
  AwarenessRoom,
  SignalingStream,
} from "@pokapali/sync";
import { Awareness } from "y-protocols/awareness";
import {
  createForwardingRecord,
  encodeForwardingRecord,
  storeForwardingRecord,
} from "./forwarding.js";
import { getHelia } from "./helia.js";
import { startRoomDiscovery } from "./peer-discovery.js";
import type { Doc, DocParams } from "./create-doc.js";
import type { Document } from "@pokapali/document";

const log = createLogger("core:rotate");

/**
 * Returned by {@link Doc.rotate}. Contains the new
 * document and a signed forwarding record that
 * redirects the old IPNS name to the new one.
 */
export interface RotateResult {
  /** The rotated document (new keys, new IPNS name). */
  newDoc: Doc;
  /** CBOR-encoded signed forwarding record. Store
   *  this to redirect old URLs to the new doc. */
  forwardingRecord: Uint8Array;
}

export interface RotateContext {
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  origin: string;
  channels: string[];
  appId: string;
  networkId: string;
  primaryChannel: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  document: Document;
  codec: import("@pokapali/codec").Codec;
}

/**
 * Rotate keys and create a new doc, returning the
 * new doc and a signed forwarding record.
 *
 * The caller must destroy the old doc after this
 * returns.
 *
 * @param createDocFn  — factory for building the
 *   replacement doc (injected to avoid circular dep)
 */
export async function rotateDoc(
  ctx: RotateContext,
  createDocFn: (params: DocParams) => Doc,
): Promise<RotateResult> {
  if (!ctx.cap.isAdmin || !ctx.keys.rotationKey) {
    throw new PermissionError(
      "Only admins can rotate a document" +
        " — this operation requires the admin URL" +
        " which includes the rotationKey",
    );
  }

  const newAdminSecret = generateAdminSecret();
  const newDocKeys = await deriveDocKeys(
    newAdminSecret,
    ctx.appId,
    ctx.channels,
  );

  const newSigningKey = await ed25519KeyPairFromSeed(newDocKeys.ipnsKeyBytes);
  const newIpnsName = bytesToHex(newSigningKey.publicKey);

  // Encode current channel state from surfaces
  const channelState: Record<string, Uint8Array> = {};
  for (const ch of ctx.channels) {
    if (ctx.document.hasSurface(ch)) {
      const handle = ctx.document.surface(ch).handle as Y.Doc;
      channelState[ch] = Y.encodeStateAsUpdate(handle);
    }
  }

  const rotateSyncOpts: SyncOptions = {
    ...ctx.syncOpts,
    ...(ctx.pubsub ? { pubsub: ctx.pubsub } : {}),
  };

  const newSyncManager = setupNamespaceRooms(
    newIpnsName,
    newDocKeys.channelKeys,
    ctx.signalingUrls,
    rotateSyncOpts,
  );

  let newRoomDiscovery;
  try {
    newRoomDiscovery = startRoomDiscovery(getHelia(), ctx.appId);
  } catch (err) {
    log.debug("room discovery skipped:", (err as Error)?.message ?? err);
  }

  // Set up awareness via direct WebRTC signaling.
  // Try to connect through a relay; fall back to a
  // placeholder if unavailable. Room discovery on the
  // new doc will upgrade awareness when a relay
  // appears.
  const newAwareness = new Awareness(new Y.Doc());
  const newAwarenessRoom = await tryRotateSignaling(
    newIpnsName,
    newAwareness,
    rotateSyncOpts,
    ctx.networkId,
    newRoomDiscovery,
  );

  const newKeys: CapabilityKeys = {
    readKey: newDocKeys.readKey,
    ipnsKeyBytes: newDocKeys.ipnsKeyBytes,
    rotationKey: newDocKeys.rotationKey,
    awarenessRoomPassword: newDocKeys.awarenessRoomPassword,
    channelKeys: newDocKeys.channelKeys,
  };

  const newAdminUrl = await buildUrl(ctx.origin, newIpnsName, newKeys);
  const newWriteChannels = newKeys.channelKeys?.["_meta"]
    ? [...ctx.channels]
    : ctx.channels.filter((ch) => ch !== "_meta");
  const newWriteUrl = await buildUrl(
    ctx.origin,
    newIpnsName,
    narrowCapability(newKeys, {
      channels: newWriteChannels,
      canPushSnapshots: true,
    }),
  );
  const newReadUrl = await buildUrl(
    ctx.origin,
    newIpnsName,
    narrowCapability(newKeys, {
      channels: [],
    }),
  );

  const newCap = inferCapability(newKeys, ctx.channels);

  const newDoc = createDocFn({
    syncManager: newSyncManager,
    awarenessRoom: newAwarenessRoom,
    cap: newCap,
    keys: newKeys,
    ipnsName: newIpnsName,
    origin: ctx.origin,
    channels: ctx.channels,
    adminUrl: newAdminUrl,
    writeUrl: newWriteUrl,
    readUrl: newReadUrl,
    signingKey: newSigningKey,
    readKey: newDocKeys.readKey,
    appId: ctx.appId,
    networkId: ctx.networkId,
    primaryChannel: ctx.primaryChannel,
    signalingUrls: ctx.signalingUrls,
    syncOpts: ctx.syncOpts,
    pubsub: ctx.pubsub,
    roomDiscovery: newRoomDiscovery,
    codec: ctx.codec,
  });

  // Apply old channel state to new doc's surfaces
  for (const [ch, state] of Object.entries(channelState)) {
    const ydoc = newDoc.channel(ch);
    Y.applyUpdate(ydoc, state);
  }

  // Create and store forwarding record
  const fwdRecord = await createForwardingRecord(
    ctx.ipnsName,
    newIpnsName,
    newReadUrl,
    ctx.keys.rotationKey,
  );
  const encoded = encodeForwardingRecord(fwdRecord);
  storeForwardingRecord(ctx.ipnsName, encoded);

  return {
    newDoc,
    forwardingRecord: encoded,
  };
}

// Short timeout for finding a relay during rotation.
// The old doc was already connected, so relays are
// typically known immediately.
const ROTATE_RELAY_WAIT_MS = 5_000;

/**
 * Try to set up signaling-based awareness for a
 * rotated doc. Waits briefly for a relay; falls back
 * to a placeholder if none is available.
 */
async function tryRotateSignaling(
  ipnsName: string,
  awareness: Awareness,
  syncOpts: SyncOptions,
  networkId: string,
  roomDiscovery?: ReturnType<typeof startRoomDiscovery>,
): Promise<AwarenessRoom> {
  if (!roomDiscovery) {
    return placeholderAwarenessRoom(awareness);
  }

  try {
    const relayPid = await roomDiscovery.waitForRelay(ROTATE_RELAY_WAIT_MS);
    const helia = getHelia();
    const localPeerId = helia.libp2p.peerId.toString();
    const conn = helia.libp2p
      .getConnections()
      .find((c) => c.remotePeer.toString() === relayPid);
    if (!conn) throw new Error("relay lost");

    const stream = await helia.libp2p.dialProtocol(
      conn.remotePeer,
      SIGNALING_PROTOCOL,
    );
    const client = createSignalingClient(stream as unknown as SignalingStream);
    const rtcConfig = syncOpts.peerOpts?.config;
    return setupSignaledAwarenessRoom(
      ipnsName,
      localPeerId,
      client,
      awareness,
      { rtcConfig, networkId },
    );
  } catch (err) {
    log.debug("signaling skipped in rotate:", (err as Error)?.message ?? err);
    return placeholderAwarenessRoom(awareness);
  }
}

/**
 * Minimal AwarenessRoom that holds an awareness
 * instance but does nothing. Used when no relay is
 * available during rotation — the new doc's room
 * discovery will upgrade when a relay connects.
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
