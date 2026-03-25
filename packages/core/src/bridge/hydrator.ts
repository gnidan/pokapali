/**
 * Hydrates a channel epoch map from a snapshot chain.
 *
 * Walks the chain from tip to genesis via
 * {@link walkChain}, decrypts each snapshot, and
 * produces one epoch per snapshot (oldest-first)
 * with a `snapshotted` boundary.
 */

import type { CID } from "multiformats/cid";
import { walkChain, decryptSnapshot } from "@pokapali/snapshot";
import type { SnapshotNode } from "@pokapali/snapshot";
import { epoch, snapshottedBoundary, edit } from "../epoch/types.js";
import type { Epoch } from "../epoch/types.js";

export interface HydrateOptions {
  /** CID of the most recent snapshot (tip). */
  tipCid: CID;
  /** Fetches raw block bytes by CID. */
  blockGetter: (cid: CID) => Promise<Uint8Array>;
  /** AES-GCM read key for decrypting snapshots. */
  readKey: CryptoKey;
}

/**
 * Walk the snapshot chain from tip, decrypt each
 * snapshot, and produce a map of channel name →
 * epochs (oldest-first). Each snapshot becomes one
 * epoch with a `snapshotted` boundary and a single
 * hydration edit per channel.
 */
export async function hydrateFromSnapshots(
  opts: HydrateOptions,
): Promise<Map<string, Epoch[]>> {
  const { tipCid, blockGetter, readKey } = opts;

  // Collect snapshots newest-first with their CIDs
  const collected: {
    node: SnapshotNode;
    block: Uint8Array;
    cid: CID;
  }[] = [];

  // walkChain yields newest-first; we need to
  // track CIDs alongside nodes. Re-fetch blocks
  // to compute CIDs (walkChain doesn't expose them).
  let currentCid: CID | null = tipCid;
  for await (const node of walkChain(tipCid, blockGetter)) {
    const block = await blockGetter(currentCid!);
    collected.push({
      node,
      block,
      cid: currentCid!,
    });
    currentCid = node.prev;
  }

  // Reverse to oldest-first
  collected.reverse();

  // Build channel → Epoch[]
  const result = new Map<string, Epoch[]>();

  for (const { node, cid } of collected) {
    const plaintexts = await decryptSnapshot(node, readKey);

    for (const [channel, payload] of Object.entries(plaintexts)) {
      if (!result.has(channel)) {
        result.set(channel, []);
      }

      const e = edit({
        payload,
        timestamp: node.ts,
        author: "",
        channel,
        origin: "hydrate",
        signature: new Uint8Array(),
      });

      result.get(channel)!.push(epoch([e], snapshottedBoundary(cid)));
    }
  }

  return result;
}
