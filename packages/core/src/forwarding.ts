import * as dagCbor from "@ipld/dag-cbor";
import {
  signBytes,
  verifyBytes,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";

/**
 * Signed record that redirects from an old document
 * IPNS name to a new one after rotation. Stored in
 * IndexedDB keyed by the old IPNS name.
 */
export interface ForwardingRecord {
  oldIpnsName: string;
  newIpnsName: string;
  newUrl: string;
  signature: Uint8Array;
}

interface SignableForwarding {
  oldIpnsName: string;
  newIpnsName: string;
  newUrl: string;
}

export async function createForwardingRecord(
  oldIpnsName: string,
  newIpnsName: string,
  newUrl: string,
  rotationKey: Uint8Array,
): Promise<ForwardingRecord> {
  const signable: SignableForwarding = {
    oldIpnsName,
    newIpnsName,
    newUrl,
  };
  const payload = dagCbor.encode(signable);
  const keypair = await ed25519KeyPairFromSeed(rotationKey);
  const signature = await signBytes(keypair, payload);
  return { oldIpnsName, newIpnsName, newUrl, signature };
}

/** CBOR-encodes a forwarding record for storage. */
export function encodeForwardingRecord(record: ForwardingRecord): Uint8Array {
  return dagCbor.encode(record);
}

/** Decodes a CBOR-encoded forwarding record. */
export function decodeForwardingRecord(bytes: Uint8Array): ForwardingRecord {
  return dagCbor.decode<ForwardingRecord>(bytes);
}

/**
 * Verifies the signature on a forwarding record
 * using the document's rotation key. Returns false
 * (never throws) on invalid or malformed records.
 */
export async function verifyForwardingRecord(
  record: ForwardingRecord,
  rotationKey: Uint8Array,
): Promise<boolean> {
  try {
    const keypair = await ed25519KeyPairFromSeed(rotationKey);
    const signable: SignableForwarding = {
      oldIpnsName: record.oldIpnsName,
      newIpnsName: record.newIpnsName,
      newUrl: record.newUrl,
    };
    const payload = dagCbor.encode(signable);
    return verifyBytes(keypair.publicKey, record.signature, payload);
  } catch {
    return false;
  }
}

// Module-level store for forwarding records.
// Keyed by old IPNS name → encoded forwarding record bytes.
const forwardingStore = new Map<string, Uint8Array>();

export function storeForwardingRecord(
  oldIpnsName: string,
  encoded: Uint8Array,
): void {
  forwardingStore.set(oldIpnsName, encoded);
}

export function lookupForwardingRecord(
  ipnsName: string,
): Uint8Array | undefined {
  return forwardingStore.get(ipnsName);
}
