/**
 * Edit hash collection and resolution utilities.
 *
 * Bridges the @pokapali/document Channel/Edit types
 * with the reconciliation session's hash-based protocol.
 *
 * @module
 */

import { sha256 } from "@noble/hashes/sha256";
import { toArray } from "@pokapali/finger-tree";
import type { Channel, Edit } from "@pokapali/document";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function hexHash(h: Uint8Array): string {
  return Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function allEdits(channel: Channel): Edit[] {
  return toArray(channel.tree).flatMap((ep) => ep.edits);
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Collect SHA-256 hashes of every edit payload in a
 * channel, preserving insertion order across epochs.
 */
export function collectEditHashes(channel: Channel): Uint8Array[] {
  return allEdits(channel).map((e) => sha256(e.payload));
}

/**
 * Build a lookup index from hex-encoded SHA-256 hash
 * to the original Edit. Duplicate payloads map to the
 * last occurrence.
 */
export function buildEditIndex(channel: Channel): Map<string, Edit> {
  const index = new Map<string, Edit>();
  for (const edit of allEdits(channel)) {
    index.set(hexHash(sha256(edit.payload)), edit);
  }
  return index;
}

/**
 * Compute the channel's reconciliation fingerprint:
 * XOR of SHA-256 hashes of all edit payloads.
 */
export function channelFingerprint(channel: Channel): Uint8Array {
  const fp = new Uint8Array(32);
  for (const edit of allEdits(channel)) {
    const h = sha256(edit.payload);
    for (let i = 0; i < 32; i++) {
      fp[i]! ^= h[i]!;
    }
  }
  return fp;
}
