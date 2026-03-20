/**
 * verify-cid.ts — CID hash verification utility.
 *
 * Computes the multihash of a block and compares it
 * against the CID's claimed hash. Rejects blocks
 * whose content doesn't match.
 */

import type { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/**
 * Verify that `hash(block)` matches the CID's
 * multihash. Returns true if the block is authentic.
 *
 * Only sha256 CIDs are supported — returns false for
 * other hash algorithms.
 */
export async function verifyCid(cid: CID, block: Uint8Array): Promise<boolean> {
  if (cid.multihash.code !== sha256.code) {
    return false;
  }
  const computed = await sha256.digest(block);
  return uint8Equal(computed.bytes, cid.multihash.bytes);
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
