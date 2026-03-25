/**
 * Hydrates a channel epoch map from a snapshot chain.
 *
 * Walks the chain from tip to genesis via
 * {@link walkChain}, decrypts each snapshot, and
 * produces one epoch per snapshot (oldest-first)
 * with a `snapshotted` boundary.
 */

import type { CID } from "multiformats/cid";
import { walkChain, decryptSnapshot } from "@pokapali/blocks";
import type { SnapshotNode } from "@pokapali/blocks";
import { Epoch, Boundary, Edit } from "@pokapali/document";
import type { Epoch as EpochType } from "@pokapali/document";

export interface Options {
  /** CID of the most recent snapshot (tip). */
  tipCid: CID;
  /** Fetches raw block bytes by CID. */
  blockGetter: (cid: CID) => Promise<Uint8Array>;
  /** AES-GCM read key for decrypting snapshots. */
  readKey: CryptoKey;
}

/**
 * Walk the snapshot chain from tip, decrypt each
 * snapshot, and produce a map of channel name ->
 * epochs (oldest-first). Each snapshot becomes one
 * epoch with a `snapshotted` boundary and a single
 * hydration edit per channel.
 */
export async function fromSnapshots(
  opts: Options,
): Promise<Map<string, EpochType[]>> {
  const { tipCid, blockGetter, readKey } = opts;

  const collected: {
    node: SnapshotNode;
    block: Uint8Array;
    cid: CID;
  }[] = [];

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

  collected.reverse();

  const result = new Map<string, EpochType[]>();

  for (const { node, cid } of collected) {
    const plaintexts = await decryptSnapshot(node, readKey);

    for (const [channel, payload] of Object.entries(plaintexts)) {
      if (!result.has(channel)) {
        result.set(channel, []);
      }

      const e = Edit.create({
        payload,
        timestamp: node.ts,
        author: "",
        channel,
        origin: "hydrate",
        signature: new Uint8Array(),
      });

      result.get(channel)!.push(Epoch.create([e], Boundary.snapshotted(cid)));
    }
  }

  return result;
}
