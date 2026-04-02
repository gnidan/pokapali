/**
 * Announce snapshot availability over GossipSub.
 *
 * Writers publish an announcement whenever they push a
 * new IPNS record. Pinners subscribe to the topic and
 * resolve the IPNS name to fetch blocks.
 */

import {
  hexToBytes,
  bytesToHex,
  signBytes,
  verifyBytes,
} from "@pokapali/crypto";

import type { Ed25519KeyPair } from "@pokapali/crypto";

/**
 * Minimal pubsub interface — only publish is needed by
 * the announcer. Kept compatible with PubSubLike from
 * @pokapali/sync but avoids requiring the full interface.
 */
export interface AnnouncePubSub {
  publish(topic: string, data: Uint8Array): Promise<unknown>;
}

export interface AnnouncementAck {
  peerId: string;
  /** Absolute timestamp (ms epoch) until which the
   *  pinner actively re-announces this doc. */
  guaranteeUntil?: number;
  /** Absolute timestamp (ms epoch) until which the
   *  pinner retains blocks in storage. */
  retainUntil?: number;
}

export interface Announcement {
  ipnsName: string;
  cid: string;
  seq?: number;
  ack?: AnnouncementAck;
  /** Base64-encoded snapshot block data. */
  block?: string;
  /** True when sent by a pinner re-announce. */
  fromPinner?: boolean;
  /** Hex-encoded Ed25519 signature proving write
   *  access: sign(docSigningKey, ipnsName+":"+cid).
   *  Absent for reader re-announces and legacy
   *  clients (migration period). */
  proof?: string;
}

/**
 * Build the GossipSub topic for snapshot announcements
 * within a given app on a given network.
 */
export function announceTopic(networkId: string, appId: string): string {
  return `/pokapali/${networkId}/app/${appId}/announce`;
}

/**
 * Publish a snapshot announcement on GossipSub.
 *
 * @param pubsub   GossipSub-compatible publish interface
 * @param appId    application identifier
 * @param ipnsName hex-encoded IPNS public key
 * @param cid      CID string of the published snapshot
 */
export const MAX_INLINE_BLOCK_BYTES = 1024 * 1024;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function announceSnapshot(
  pubsub: AnnouncePubSub,
  networkId: string,
  appId: string,
  ipnsName: string,
  cid: string,
  seq?: number,
  block?: Uint8Array,
  fromPinner?: boolean,
  ack?: AnnouncementAck,
  proof?: string,
): Promise<void> {
  const topic = announceTopic(networkId, appId);
  const msg: Announcement = { ipnsName, cid };
  if (seq !== undefined) msg.seq = seq;
  if (block && block.length <= MAX_INLINE_BLOCK_BYTES) {
    msg.block = uint8ToBase64(block);
  }
  if (fromPinner) msg.fromPinner = true;
  if (ack) msg.ack = ack;
  if (proof) msg.proof = proof;
  const data = new TextEncoder().encode(JSON.stringify(msg));
  await pubsub.publish(topic, data);
}

/**
 * Publish a pinner acknowledgment on GossipSub.
 * Sent after a pinner successfully fetches and
 * validates a snapshot block.
 */
export async function announceAck(
  pubsub: AnnouncePubSub,
  networkId: string,
  appId: string,
  ipnsName: string,
  cid: string,
  peerId: string,
  guaranteeUntil?: number,
  retainUntil?: number,
): Promise<void> {
  const topic = announceTopic(networkId, appId);
  const ack: AnnouncementAck = { peerId };
  if (guaranteeUntil !== undefined) {
    ack.guaranteeUntil = guaranteeUntil;
  }
  if (retainUntil !== undefined) {
    ack.retainUntil = retainUntil;
  }
  const msg: Announcement = {
    ipnsName,
    cid,
    ack,
  };
  const data = new TextEncoder().encode(JSON.stringify(msg));
  await pubsub.publish(topic, data);
}

// Max inbound message size (2MB). A 1MB block becomes
// ~1.33MB base64, plus JSON envelope. 2MB gives
// headroom while rejecting obvious abuse.
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Parse a raw announcement message payload.
 *
 * @returns parsed Announcement or null if invalid
 */
export function parseAnnouncement(data: Uint8Array): Announcement | null {
  try {
    if (data.length > MAX_MESSAGE_BYTES) return null;

    const text = new TextDecoder().decode(data);
    const obj = JSON.parse(text);
    if (typeof obj.ipnsName !== "string" || typeof obj.cid !== "string") {
      return null;
    }

    // Validate inline block size after base64 decode.
    // base64 output is ~4/3 of input, so check the
    // encoded length as a fast approximation first.
    if (typeof obj.block === "string") {
      const approxBytes = (obj.block.length * 3) / 4;
      if (approxBytes > MAX_INLINE_BLOCK_BYTES) {
        // Strip oversized block — still return the
        // announcement so the CID is tracked.
        delete obj.block;
      }
    }

    return obj as Announcement;
  } catch {
    return null;
  }
}

// --- Announcement proof (Tier 1 auth, #75) ---

/**
 * Sign an announcement proof using the doc signing key.
 * proof = hex(sign(signingKey, utf8(ipnsName + ":" + cid)))
 */
export async function signAnnouncementProof(
  signingKey: Ed25519KeyPair,
  ipnsName: string,
  cid: string,
): Promise<string> {
  const payload = new TextEncoder().encode(ipnsName + ":" + cid);
  const sig = await signBytes(signingKey, payload);
  return bytesToHex(sig);
}

/**
 * Verify an announcement proof. The ipnsName IS the
 * hex-encoded Ed25519 public key, so no key distribution
 * is needed — the verifier derives the public key from
 * the ipnsName itself.
 */
export async function verifyAnnouncementProof(
  ipnsName: string,
  cid: string,
  proof: string,
): Promise<boolean> {
  try {
    const publicKey = hexToBytes(ipnsName);
    const sig = hexToBytes(proof);
    const payload = new TextEncoder().encode(ipnsName + ":" + cid);
    return await verifyBytes(publicKey, sig, payload);
  } catch {
    return false;
  }
}

// --- Guarantee query / response ---

export interface GuaranteeResponse {
  type: "guarantee-response";
  ipnsName: string;
  peerId: string;
  cid: string;
  guaranteeUntil?: number;
  retainUntil?: number;
}

/**
 * Publish a guarantee query on the announce topic.
 * Browsers fire this on doc open so pinners respond
 * with their current guarantee state.
 */
export async function publishGuaranteeQuery(
  pubsub: AnnouncePubSub,
  networkId: string,
  appId: string,
  ipnsName: string,
): Promise<void> {
  const topic = announceTopic(networkId, appId);
  const data = new TextEncoder().encode(
    JSON.stringify({
      type: "guarantee-query",
      ipnsName,
    }),
  );
  await pubsub.publish(topic, data);
}

/**
 * Parse a guarantee response from raw message data.
 *
 * @returns parsed GuaranteeResponse or null
 */
export function parseGuaranteeResponse(
  data: Uint8Array,
): GuaranteeResponse | null {
  try {
    if (data.length > MAX_MESSAGE_BYTES) return null;

    const text = new TextDecoder().decode(data);
    const obj = JSON.parse(text);
    if (
      obj?.type !== "guarantee-response" ||
      typeof obj.ipnsName !== "string" ||
      typeof obj.peerId !== "string" ||
      typeof obj.cid !== "string"
    ) {
      return null;
    }
    return obj as GuaranteeResponse;
  } catch {
    return null;
  }
}
