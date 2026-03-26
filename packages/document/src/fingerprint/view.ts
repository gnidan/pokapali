/**
 * Fingerprint view: order-independent content hash.
 *
 * Each edit's payload is hashed with SHA-256, then
 * hashes are combined via XOR. Because XOR is
 * commutative and associative, the result is the same
 * regardless of edit order within or across epochs.
 *
 * Two peers with the same set of edits but different
 * epoch boundaries will produce the same root hash.
 */
import { sha256 } from "@noble/hashes/sha256";
import type { Measured } from "@pokapali/finger-tree";
import type { Epoch } from "#history";
import type { View } from "../view.js";
import { View as ViewCompanion } from "../view.js";

/** XOR two 32-byte arrays. */
function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return result;
}

function measureEpochHash(ep: Epoch): Uint8Array {
  let acc: Uint8Array = new Uint8Array(32);
  for (const e of ep.edits) {
    acc = xor(acc, sha256(e.payload));
  }
  return acc;
}

/**
 * Create the per-channel Measured for a Fingerprint
 * view. SHA-256 + XOR: order-independent content hash.
 *
 * The monoid:
 * - identity: 32 zero bytes
 * - append: XOR
 *
 * The measure: XOR of SHA-256 hashes of all edit
 * payloads in the epoch.
 */
export function channelMeasured(): Measured<Uint8Array, Epoch> {
  return {
    monoid: {
      empty: new Uint8Array(32),
      append: xor,
    },
    measure: measureEpochHash,
  };
}

/**
 * Create a multi-channel Fingerprint View spanning
 * content and comments channels.
 *
 * Each channel uses the same SHA-256 + XOR measured.
 * The combine function XORs both channel results.
 */
export function view(): View<Uint8Array> {
  const measured = channelMeasured();

  return ViewCompanion.create({
    name: "content-hash",
    description: "Order-independent content hash " + "(SHA-256 + XOR)",
    channels: {
      content: measured,
      comments: measured,
    },
    combine: (results) =>
      xor(results.content as Uint8Array, results.comments as Uint8Array),
  });
}
