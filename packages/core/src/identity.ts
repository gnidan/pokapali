/**
 * Identity persistence — generate or load a
 * per-device Ed25519 keypair via Store.Identity.
 *
 * One keypair per appId. The keypair identifies this
 * browser/device across all docs for the app.
 */

import type { Ed25519KeyPair } from "@pokapali/crypto";
import {
  ed25519KeyPairFromSeed,
  bytesToHex,
  signBytes,
} from "@pokapali/crypto";
import type { Store } from "@pokapali/store";

const KEY_ID = "device";

/**
 * Load or generate the device identity keypair.
 * Persists the seed via Store.Identity so the same
 * identity is used across page reloads.
 */
export async function loadIdentity(
  identity: Store.Identity,
): Promise<Ed25519KeyPair> {
  const existing = await identity.load(KEY_ID);
  if (existing) {
    return ed25519KeyPairFromSeed(existing);
  }
  // Generate new seed
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  await identity.save(KEY_ID, seed);
  return ed25519KeyPairFromSeed(seed);
}

/**
 * Sign a participant awareness payload. When
 * clientId is provided, produces a v2 signature
 * binding the identity to a specific clientID
 * (prevents replay under a different clientID).
 *
 * v1 payload: `pubkeyHex:docId`
 * v2 payload: `pubkeyHex:clientId:docId`
 */
export async function signParticipant(
  keypair: Ed25519KeyPair,
  docId: string,
  clientId?: number,
): Promise<{ sig: string; v?: 2 }> {
  const pubkeyHex = bytesToHex(keypair.publicKey);
  const payload =
    clientId !== undefined
      ? pubkeyHex + ":" + clientId + ":" + docId
      : pubkeyHex + ":" + docId;
  const sig = await signBytes(keypair, new TextEncoder().encode(payload));
  return clientId !== undefined
    ? { sig: bytesToHex(sig), v: 2 }
    : { sig: bytesToHex(sig) };
}

export interface ParticipantAwareness {
  pubkey: string;
  displayName?: string;
  sig: string;
  /** Signature format version. Absent = v1. */
  v?: 2;
}
