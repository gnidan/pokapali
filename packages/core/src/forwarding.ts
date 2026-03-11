import * as dagCbor from "@ipld/dag-cbor";
import {
  signBytes,
  verifySignature,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import type { Ed25519KeyPair } from "@pokapali/crypto";

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

export function encodeForwardingRecord(record: ForwardingRecord): Uint8Array {
  return dagCbor.encode(record);
}

export function decodeForwardingRecord(bytes: Uint8Array): ForwardingRecord {
  return dagCbor.decode<ForwardingRecord>(bytes);
}

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
    return verifySignature(keypair.publicKey, record.signature, payload);
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

export function clearForwardingStore(): void {
  forwardingStore.clear();
}
