/**
 * Epoch and Boundary types with companion objects.
 *
 * An **epoch** is an unordered bag of causally
 * concurrent edits between two causal boundaries.
 * Edits within an epoch have no meaningful ordering
 * — they happened "at the same time" from the
 * CRDT's perspective.
 *
 * A **boundary** is a 3-state discriminated union:
 * open (live tip), closed (converged), or
 * snapshotted (checkpointed with a CID).
 */

import type { CID } from "multiformats/cid";
import type { Codec } from "@pokapali/codec";
import type { Edit } from "./edit.js";
import type { History } from "./history.js";
import { epochMeasured } from "./summary.js";
import { split, concat, snoc } from "@pokapali/finger-tree";

// -------------------------------------------------
// Boundary
// -------------------------------------------------

/**
 * The trailing boundary of an epoch.
 *
 * Three states:
 * - **open** — the current epoch, still accumulating
 *   edits. Always and only the rightmost element in
 *   the tree.
 * - **closed** — convergence detected (all peers
 *   exchanged all in-flight edits). Causal ordering
 *   established. No snapshot persisted.
 * - **snapshotted** — a deliberate checkpoint. The
 *   merged document state at this boundary is stored
 *   as a content-addressed block (CID).
 *
 * Transitions:
 * - open → closed (peers converge, editing pauses)
 * - open → snapshotted (converge + immediate snap)
 * - closed → snapshotted (snapshot created later)
 * - snapshotted → closed (pinner prunes snapshot)
 */
export type Boundary =
  | { readonly tag: "open" }
  | { readonly tag: "closed" }
  | { readonly tag: "snapshotted"; readonly cid: CID };

/** @deprecated Use `Boundary` instead. */
export type EpochBoundary = Boundary;

/**
 * Companion object for the Boundary type.
 */
export const Boundary = {
  /** Construct an open boundary. */
  open(): Boundary {
    return { tag: "open" };
  },

  /** Construct a closed boundary. */
  closed(): Boundary {
    return { tag: "closed" };
  },

  /** Construct a snapshotted boundary. */
  snapshotted(cid: CID): Boundary {
    return { tag: "snapshotted", cid };
  },
};

// -------------------------------------------------
// Epoch
// -------------------------------------------------

/**
 * An epoch: an unordered bag of causally concurrent
 * edits with a trailing boundary.
 *
 * The leading boundary is the previous epoch's
 * trailing boundary (or the implicit empty-document
 * origin for the first epoch in the tree).
 *
 * An epoch with an empty `edits` array means
 * "something happened here but we don't have the
 * details yet" — the opaque hydration case where a
 * pinner gives you a snapshot without fine-grained
 * history.
 */
export interface Epoch {
  /**
   * Edits in this epoch. Unordered — concurrent
   * from the CRDT's perspective.
   */
  readonly edits: readonly Edit[];

  /** Trailing boundary of this epoch. */
  readonly boundary: Boundary;
}

/**
 * Companion object for the Epoch type.
 */
export const Epoch = {
  /**
   * Construct an epoch.
   */
  create(edits: readonly Edit[], boundary: Boundary): Epoch {
    return { edits, boundary };
  },

  /**
   * Append an edit to an epoch. Returns a new epoch.
   *
   * Throws if the epoch's boundary is not open.
   */
  append(ep: Epoch, e: Edit): Epoch {
    if (ep.boundary.tag !== "open") {
      throw new Error("Cannot append edit to a non-open epoch");
    }
    return {
      edits: [...ep.edits, e],
      boundary: ep.boundary,
    };
  },

  /**
   * Whether the epoch's boundary is open.
   */
  isOpen(ep: Epoch): boolean {
    return ep.boundary.tag === "open";
  },

  /**
   * Close an open epoch (transition boundary to
   * closed). Throws if not open.
   */
  close(ep: Epoch): Epoch {
    if (ep.boundary.tag !== "open") {
      throw new Error("Can only close an open epoch");
    }
    return {
      edits: ep.edits,
      boundary: Boundary.closed(),
    };
  },

  /**
   * Snapshot an epoch (transition boundary to
   * snapshotted). Throws if boundary is open.
   */
  snapshot(ep: Epoch, cid: CID): Epoch {
    if (ep.boundary.tag === "open") {
      throw new Error("Cannot snapshot an open epoch");
    }
    return {
      edits: ep.edits,
      boundary: Boundary.snapshotted(cid),
    };
  },

  /**
   * Merge two epochs: union edits, take b's
   * boundary.
   *
   * Both epochs must have non-open boundaries. You
   * cannot merge into or out of the live tip.
   */
  merge(a: Epoch, b: Epoch): Epoch {
    if (a.boundary.tag === "open") {
      throw new Error("Cannot merge epoch with open boundary");
    }
    if (b.boundary.tag === "open") {
      throw new Error("Cannot merge epoch with open boundary");
    }
    return Epoch.create([...a.edits, ...b.edits], b.boundary);
  },

  /**
   * Split an epoch in the tree at a snapshot
   * boundary.
   *
   * For each edit in the epoch at `position`, tests
   * `codec.contains(snapshot, edit.payload)` to
   * partition edits into before (contained) and
   * after (not contained).
   *
   * Replaces the single epoch with two:
   * - before: edits contained by snapshot,
   *   boundary = snapshotted(cid)
   * - after: remaining edits, boundary = original
   *
   * @param tree     The history tree
   * @param position 1-based epoch position
   * @param snapshot Snapshot state bytes
   * @param cid      CID of the snapshot block
   * @param codec    Codec for contains checks
   * @returns New tree with one more epoch
   */
  splitAtSnapshot(
    tree: History,
    position: number,
    snapshot: Uint8Array,
    cid: CID,
    codec: Codec,
  ): History {
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
    const before: Edit[] = [];
    const after: Edit[] = [];
    for (const e of target.edits) {
      if (codec.contains(snapshot, e.payload)) {
        before.push(e);
      } else {
        after.push(e);
      }
    }

    const beforeEpoch = Epoch.create(before, Boundary.snapshotted(cid));
    const afterEpoch = Epoch.create(after, target.boundary);

    // Rebuild: left ++ [before, after] ++ right
    const withBefore = snoc(epochMeasured, s.left, beforeEpoch);
    const withBoth = snoc(epochMeasured, withBefore, afterEpoch);
    return concat(epochMeasured, withBoth, s.right);
  },
};
