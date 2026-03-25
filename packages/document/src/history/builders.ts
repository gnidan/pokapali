/**
 * Tree builders for hydration.
 *
 * `fromSnapshots` builds a coarse tree from a
 * snapshot chain — each snapshot becomes an epoch
 * with empty edits and a snapshotted boundary.
 *
 * `backfillEdits` distributes edits into the correct
 * epochs by testing `codec.contains` against each
 * snapshot's state bytes.
 */
import type { CID } from "multiformats/cid";
import { Epoch, Boundary } from "./epoch.js";
import type { Edit } from "./edit.js";
import type { Codec } from "@pokapali/codec";
import type { History } from "./history.js";

// NOTE: we cannot import fromEpochs from
// ./history.js due to circular dependency at the
// module level (history.ts imports from builders.ts
// for the History companion). Instead, we build
// directly with finger-tree primitives.
import { fromArray } from "@pokapali/finger-tree";
import { epochMeasured } from "./summary.js";

export interface Snapshot {
  readonly cid: CID;
  readonly state: Uint8Array;
}

/**
 * Build a coarse History from a snapshot chain.
 *
 * Each snapshot becomes an epoch with empty edits
 * and a snapshotted boundary. The resulting tree
 * represents the document's history at the coarsest
 * granularity — no fine-grained edits yet.
 */
export function fromSnapshots(snapshots: readonly Snapshot[]): History {
  return fromArray(
    epochMeasured,
    snapshots.map((s) => Epoch.create([], Boundary.snapshotted(s.cid))),
  );
}

/**
 * Distribute edits across epochs defined by a
 * snapshot chain.
 *
 * For each edit, finds the snapshot where it first
 * appears — contained by snapshot[i] but NOT by
 * snapshot[i-1]. This places the edit in the epoch
 * where it was new. Edits not contained by any
 * snapshot go into a trailing closed epoch.
 *
 * Returns a tree with edits distributed across
 * epochs matching the snapshot boundaries.
 */
export function backfillEdits(
  snapshots: readonly Snapshot[],
  edits: readonly Edit[],
  codec: Codec,
): History {
  if (snapshots.length === 0) {
    return fromArray(epochMeasured, []);
  }

  // Bucket edits by earliest containing snapshot.
  // buckets[i] = edits for snapshot i
  // buckets[snapshots.length] = remainder (not in
  // any)
  const buckets: Edit[][] = Array.from(
    { length: snapshots.length + 1 },
    () => [],
  );

  for (const e of edits) {
    let placed = false;
    for (let i = 0; i < snapshots.length; i++) {
      if (codec.contains(snapshots[i]!.state, e.payload)) {
        // Linear scan guarantees this is the earliest
        // containing snapshot — all S[j<i] were
        // already checked and returned false.
        buckets[i]!.push(e);
        placed = true;
        break;
      }
    }
    if (!placed) {
      buckets[snapshots.length]!.push(e);
    }
  }

  // Build epoch list
  const result = snapshots.map((s, i) =>
    Epoch.create(buckets[i]!, Boundary.snapshotted(s.cid)),
  );

  // Add remainder epoch if needed
  const remainder = buckets[snapshots.length]!;
  if (remainder.length > 0) {
    result.push(Epoch.create(remainder, Boundary.closed()));
  }

  return fromArray(epochMeasured, result);
}
