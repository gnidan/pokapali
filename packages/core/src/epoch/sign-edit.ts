/**
 * Per-edit Ed25519 envelope: sign and verify.
 *
 * Wire format (97-byte header + N-byte payload):
 *   [1B version][32B pubkey][64B signature][NB payload]
 *
 * signEdit produces a self-contained envelope.
 * verifyEdit parses it, checks the signature, and
 * optionally checks the signer against a trusted key
 * set. Returns null (never throws) for any invalid
 * input.
 *
 * @module
 */

import type { Ed25519KeyPair } from "@pokapali/crypto";
import { signBytes, verifyBytes, bytesToHex } from "@pokapali/crypto";

/** Current envelope version byte. */
export const ENVELOPE_VERSION = 1;

/** Size of the fixed header: 1 + 32 + 64. */
export const HEADER_SIZE = 97;

/**
 * Result of a successful verification: the original
 * payload and the signer's public key.
 */
export interface VerifiedEdit {
  payload: Uint8Array;
  pubkey: Uint8Array;
}

/**
 * Sign an edit payload and produce a self-contained
 * envelope.
 *
 * @returns Uint8Array of HEADER_SIZE + payload.length
 */
export async function signEdit(
  payload: Uint8Array,
  keypair: Ed25519KeyPair,
): Promise<Uint8Array> {
  const sig = await signBytes(keypair, payload);
  const envelope = new Uint8Array(HEADER_SIZE + payload.length);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(keypair.publicKey, 1);
  envelope.set(sig, 33);
  envelope.set(payload, HEADER_SIZE);
  return envelope;
}

/**
 * Verify a signed edit envelope.
 *
 * Returns null (never throws) when:
 * - envelope is too short or has wrong version
 * - signature is cryptographically invalid
 * - signer is not in trustedKeys (when provided and
 *   non-empty)
 *
 * @param envelope  The full wire envelope
 * @param trustedKeys  Optional set of hex-encoded
 *   public keys. When provided and non-empty, the
 *   signer must be in the set.
 */
export async function verifyEdit(
  envelope: Uint8Array,
  trustedKeys?: ReadonlySet<string>,
): Promise<VerifiedEdit | null> {
  if (envelope.length < HEADER_SIZE) return null;

  const version = envelope[0];
  if (version !== ENVELOPE_VERSION) return null;

  const pubkey = envelope.slice(1, 33);
  const signature = envelope.slice(33, HEADER_SIZE);
  const payload = envelope.slice(HEADER_SIZE);

  // Trusted-key gate: reject before doing the
  // (more expensive) crypto verify.
  if (trustedKeys && trustedKeys.size > 0) {
    const hex = bytesToHex(pubkey);
    if (!trustedKeys.has(hex)) return null;
  }

  const valid = await verifyBytes(pubkey, signature, payload);
  if (!valid) return null;

  return { payload, pubkey };
}
