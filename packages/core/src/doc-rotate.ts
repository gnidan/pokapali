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
import { createSubdocManager } from "@pokapali/subdocs";
import type { SubdocManager } from "@pokapali/subdocs";
import { setupNamespaceRooms, setupAwarenessRoom } from "@pokapali/sync";
import type { SyncOptions, PubSubLike } from "@pokapali/sync";
import {
  createForwardingRecord,
  encodeForwardingRecord,
  storeForwardingRecord,
} from "./forwarding.js";
import { getHelia } from "./helia.js";
import { startRoomDiscovery } from "./peer-discovery.js";
import type { Doc, DocParams } from "./create-doc.js";

const log = createLogger("core:rotate");

export interface RotateResult {
  newDoc: Doc;
  forwardingRecord: Uint8Array;
}

export interface RotateContext {
  cap: Capability;
  keys: CapabilityKeys;
  ipnsName: string;
  origin: string;
  channels: string[];
  appId: string;
  primaryChannel: string;
  signalingUrls: string[];
  syncOpts?: SyncOptions;
  pubsub?: PubSubLike;
  subdocManager: SubdocManager;
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
  populateMetaFn: (
    metaDoc: import("yjs").Doc,
    signingPublicKey: Uint8Array,
    channelKeys: Record<string, Uint8Array>,
  ) => void,
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

  // Copy current state to new subdoc manager
  const newSubdocManager = createSubdocManager(newIpnsName, ctx.channels, {
    primaryNamespace: ctx.primaryChannel,
  });
  const snapshot = ctx.subdocManager.encodeAll();
  newSubdocManager.applySnapshot(snapshot);

  const rotateSyncOpts: SyncOptions = {
    ...ctx.syncOpts,
    ...(ctx.pubsub ? { pubsub: ctx.pubsub } : {}),
  };

  const newSyncManager = setupNamespaceRooms(
    newIpnsName,
    newSubdocManager,
    newDocKeys.channelKeys,
    ctx.signalingUrls,
    rotateSyncOpts,
  );

  const newAwarenessRoom = setupAwarenessRoom(
    newIpnsName,
    newDocKeys.awarenessRoomPassword,
    ctx.signalingUrls,
    rotateSyncOpts,
  );

  const newKeys: CapabilityKeys = {
    readKey: newDocKeys.readKey,
    ipnsKeyBytes: newDocKeys.ipnsKeyBytes,
    rotationKey: newDocKeys.rotationKey,
    awarenessRoomPassword: newDocKeys.awarenessRoomPassword,
    channelKeys: newDocKeys.channelKeys,
  };

  const newAdminUrl = await buildUrl(ctx.origin, newIpnsName, newKeys);
  const newWriteUrl = await buildUrl(
    ctx.origin,
    newIpnsName,
    narrowCapability(newKeys, {
      channels: [...ctx.channels],
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

  populateMetaFn(
    newSubdocManager.metaDoc,
    newSigningKey.publicKey,
    newDocKeys.channelKeys,
  );

  let newRoomDiscovery;
  try {
    newRoomDiscovery = startRoomDiscovery(getHelia(), ctx.appId);
  } catch (err) {
    log.debug("room discovery skipped:", (err as Error)?.message ?? err);
  }

  const newDoc = createDocFn({
    subdocManager: newSubdocManager,
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
    primaryChannel: ctx.primaryChannel,
    signalingUrls: ctx.signalingUrls,
    syncOpts: ctx.syncOpts,
    pubsub: ctx.pubsub,
    roomDiscovery: newRoomDiscovery,
  });

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
