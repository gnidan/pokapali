/**
 * Epoch splitting (progressive refinement).
 *
 * Given a snapshot and a CrdtCodec, partition an
 * epoch's edits into "before" (contained by snapshot)
 * and "after" (not contained), replacing the single
 * epoch with two sub-epochs in the tree.
 *
 * Use case: a peer receives a snapshot and refines
 * coarse history into finer epochs. The "before"
 * epoch gets a snapshotted boundary; the "after"
 * epoch inherits the original boundary.
 */
import type { CID } from "multiformats/cid";
import { split, concat, snoc } from "@pokapali/finger-tree";
import { epochMeasured } from "./index-monoid.js";
import { epoch, snapshottedBoundary } from "./types.js";
import type { CrdtCodec } from "../codec/codec.js";
import type { EpochTree } from "./tree.js";

/**
 * Split an epoch in the tree at a snapshot boundary.
 *
 * For each edit in the epoch at `position`, tests
 * `codec.contains(snapshot, edit.payload)` to
 * partition edits into before (contained) and after
 * (not contained).
 *
 * Replaces the single epoch with two:
 * - before: edits contained by snapshot, boundary =
 *   snapshotted(cid)
 * - after: remaining edits, boundary = original
 *
 * @param tree     The epoch tree
 * @param position 1-based epoch position
 * @param snapshot Snapshot state bytes
 * @param cid      CID of the snapshot block
 * @param codec    CrdtCodec for contains checks
 * @returns New tree with one more epoch
 */
export function splitEpochAtSnapshot(
  tree: EpochTree,
  position: number,
  snapshot: Uint8Array,
  cid: CID,
  codec: CrdtCodec,
): EpochTree {
  if (position < 1) {
    throw new Error("Position must be >= 1");
  }

  const s = split(epochMeasured, (v) => v.epochCount >= position, tree);
  if (!s) {
    throw new Error("Position beyond tree size");
  }

  const target = s.value;
  if (target.boundary.tag === "open") {
    throw new Error("Cannot split an epoch with open boundary");
  }

  // Partition edits
  const before = [];
  const after = [];
  for (const e of target.edits) {
    if (codec.contains(snapshot, e.payload)) {
      before.push(e);
    } else {
      after.push(e);
    }
  }

  const beforeEpoch = epoch(before, snapshottedBoundary(cid));
  const afterEpoch = epoch(after, target.boundary);

  // Rebuild: left ++ [before, after] ++ right
  const withBefore = snoc(epochMeasured, s.left, beforeEpoch);
  const withBoth = snoc(epochMeasured, withBefore, afterEpoch);
  return concat(epochMeasured, withBoth, s.right);
}
