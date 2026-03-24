/**
 * Domain types for the epoch system.
 *
 * An **epoch** is an unordered bag of causally
 * concurrent edits between two causal boundaries.
 * Edits within an epoch have no meaningful ordering
 * — they happened "at the same time" from the
 * CRDT's perspective.
 *
 * An **edit** is a single CRDT operation with
 * forensic metadata: who, when, which channel, how
 * it arrived, and a self-verifying signature.
 *
 * An **epoch boundary** is a 3-state discriminated
 * union: open (live tip), closed (converged), or
 * snapshotted (checkpointed with a CID).
 */

import type { CID } from "multiformats/cid";

// -------------------------------------------------
// Edit
// -------------------------------------------------

/**
 * How an edit arrived in the local document.
 *
 * - `local` — typed by this user
 * - `sync` — received from a peer via y-webrtc
 * - `hydrate` — replayed from a snapshot or IDB
 */
export type EditOrigin = "local" | "sync" | "hydrate";

/**
 * A single CRDT operation with forensic metadata.
 *
 * The `payload` field is an opaque byte array whose
 * format is determined by the CrdtCodec in use
 * (e.g., a Yjs update). The codec interprets the
 * bytes; the epoch system just stores them.
 *
 * Every edit with an `author` carries a `signature`
 * — self-verifying, even years later when replaying
 * from IDB. Enables replay and diagnosis when CRDT
 * merges go wrong.
 */
export interface Edit {
  /** Opaque CRDT update bytes. */
  readonly payload: Uint8Array;

  /** Unix timestamp (ms) when the edit was created. */
  readonly timestamp: number;

  /**
   * Hex-encoded Ed25519 public key of the peer that
   * produced this edit.
   */
  readonly author: string;

  /** Channel this edit belongs to. */
  readonly channel: string;

  /** How this edit arrived locally. */
  readonly origin: EditOrigin;

  /**
   * Ed25519 signature over `payload` by `author`.
   * Empty Uint8Array if unsigned.
   */
  readonly signature: Uint8Array;
}

/**
 * Construct an Edit value.
 */
export function edit(fields: {
  payload: Uint8Array;
  timestamp: number;
  author: string;
  channel: string;
  origin: EditOrigin;
  signature: Uint8Array;
}): Edit {
  return { ...fields };
}

// -------------------------------------------------
// EpochBoundary
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
export type EpochBoundary =
  | { readonly tag: "open" }
  | { readonly tag: "closed" }
  | { readonly tag: "snapshotted"; readonly cid: CID };

/** Construct an open boundary. */
export function openBoundary(): EpochBoundary {
  return { tag: "open" };
}

/** Construct a closed boundary. */
export function closedBoundary(): EpochBoundary {
  return { tag: "closed" };
}

/** Construct a snapshotted boundary. */
export function snapshottedBoundary(cid: CID): EpochBoundary {
  return { tag: "snapshotted", cid };
}

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
  readonly boundary: EpochBoundary;
}

/**
 * Construct an epoch.
 */
export function epoch(edits: readonly Edit[], boundary: EpochBoundary): Epoch {
  return { edits, boundary };
}

/**
 * Append an edit to an epoch. Returns a new epoch.
 *
 * Throws if the epoch's boundary is not open.
 */
export function appendEdit(ep: Epoch, e: Edit): Epoch {
  if (ep.boundary.tag !== "open") {
    throw new Error("Cannot append edit to a non-open epoch");
  }
  return {
    edits: [...ep.edits, e],
    boundary: ep.boundary,
  };
}

/**
 * Whether the epoch's boundary is open.
 */
export function isOpen(ep: Epoch): boolean {
  return ep.boundary.tag === "open";
}

/**
 * Close an open epoch (transition boundary to
 * closed). Throws if not open.
 */
export function closeEpoch(ep: Epoch): Epoch {
  if (ep.boundary.tag !== "open") {
    throw new Error("Can only close an open epoch");
  }
  return { edits: ep.edits, boundary: closedBoundary() };
}

/**
 * Snapshot an epoch (transition boundary to
 * snapshotted). Throws if boundary is open.
 */
export function snapshotEpoch(ep: Epoch, cid: CID): Epoch {
  if (ep.boundary.tag === "open") {
    throw new Error("Cannot snapshot an open epoch");
  }
  return {
    edits: ep.edits,
    boundary: snapshottedBoundary(cid),
  };
}
