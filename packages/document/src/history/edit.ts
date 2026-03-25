/**
 * Edit: a single CRDT operation with forensic
 * metadata.
 *
 * The `payload` field is an opaque byte array whose
 * format is determined by the Codec in use (e.g., a
 * Yjs update). The codec interprets the bytes; the
 * history system just stores them.
 *
 * Every edit with an `author` carries a `signature`
 * — self-verifying, even years later when replaying
 * from IDB. Enables replay and diagnosis when CRDT
 * merges go wrong.
 */

// -------------------------------------------------
// Origin (formerly EditOrigin)
// -------------------------------------------------

/**
 * How an edit arrived in the local document.
 *
 * - `local` — typed by this user
 * - `sync` — received from a peer via y-webrtc
 * - `hydrate` — replayed from a snapshot or IDB
 */
export type Origin = "local" | "sync" | "hydrate";

/** @deprecated Use `Origin` instead. */
export type EditOrigin = Origin;

// -------------------------------------------------
// Edit
// -------------------------------------------------

/**
 * A single CRDT operation with forensic metadata.
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
  readonly origin: Origin;

  /**
   * Ed25519 signature over `payload` by `author`.
   * Empty Uint8Array if unsigned.
   */
  readonly signature: Uint8Array;
}

/**
 * Companion object for the Edit type.
 */
export const Edit = {
  /**
   * Construct an Edit value.
   */
  create(fields: {
    payload: Uint8Array;
    timestamp: number;
    author: string;
    channel: string;
    origin: Origin;
    signature: Uint8Array;
  }): Edit {
    return { ...fields };
  },
};
