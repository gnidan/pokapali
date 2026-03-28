/**
 * Per-edit Ed25519 signatures.
 *
 * Thin wrappers around @pokapali/crypto's signBytes
 * and verifyBytes, scoped to edit payloads.
 */

import type { Ed25519KeyPair } from "@pokapali/crypto";
import { signBytes, verifyBytes } from "@pokapali/crypto";

/**
 * Sign an edit payload with an Ed25519 keypair.
 *
 * @returns 64-byte Ed25519 signature
 */
export async function signEdit(
  payload: Uint8Array,
  keypair: Ed25519KeyPair,
): Promise<Uint8Array> {
  return signBytes(keypair, payload);
}

/**
 * Verify an Ed25519 signature over an edit payload.
 *
 * Returns `false` (does not throw) for empty
 * signatures — backward compat with unsigned edits.
 */
export async function verifyEdit(
  payload: Uint8Array,
  signature: Uint8Array,
  pubkey: Uint8Array,
): Promise<boolean> {
  if (signature.length === 0) return false;
  return verifyBytes(pubkey, signature, payload);
}
