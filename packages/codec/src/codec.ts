/**
 * Codec -- the CRDT abstraction boundary.
 *
 * All epoch machinery interacts with CRDT state
 * exclusively through this interface. The underlying
 * CRDT library (Yjs, Automerge, etc.) is an
 * implementation detail hidden behind these five
 * operations.
 *
 * State and updates are represented as opaque
 * `Uint8Array` values. The codec knows how to
 * interpret them; callers do not.
 */

/**
 * Five operations that fully characterize the CRDT
 * from the epoch system's perspective.
 */
export interface Codec {
  /**
   * Merge two states into one that contains all
   * operations from both.
   *
   * Must be:
   * - **Commutative**: merge(a, b) === merge(b, a)
   * - **Associative**: merge(merge(a, b), c) ===
   *   merge(a, merge(b, c))
   * - **Idempotent**: merge(a, a) === a
   */
  merge(a: Uint8Array, b: Uint8Array): Uint8Array;

  /**
   * Compute the delta: operations in `state` that
   * are NOT covered by `base`.
   *
   * `diff(state, base)` returns the minimal update
   * that, when applied to `base`, would bring it
   * up to `state`.
   *
   * If `base` already contains `state`, the result
   * is an empty update.
   */
  diff(state: Uint8Array, base: Uint8Array): Uint8Array;

  /**
   * Apply an update (full state or delta) to a base
   * state, returning the merged result.
   *
   * Equivalent to `merge(base, update)` but may be
   * optimized for the delta case.
   */
  apply(base: Uint8Array, update: Uint8Array): Uint8Array;

  /**
   * Return an empty CRDT state (the identity element
   * for merge).
   *
   * merge(empty(), x) === x for all x.
   */
  empty(): Uint8Array;

  /**
   * Check whether `snapshot` contains all operations
   * present in `edit`.
   *
   * Returns true iff applying `edit` to `snapshot`
   * would not add any new operations.
   */
  contains(snapshot: Uint8Array, edit: Uint8Array): boolean;

  /**
   * Create a rendering surface. The surface owns
   * a live CRDT document that editors can bind to.
   * Codec-internal type exposed via opaque handle.
   */
  createSurface(opts?: { guid?: string }): CodecSurface;

  /**
   * Sum of CRDT-internal clocks for the given
   * merged state. Used as IPNS sequence number.
   *
   * Must be:
   * - **Monotonically increasing** with edits
   * - **Deterministic** from state (same edits →
   *   same sum)
   *
   * For Yjs: sum of state vector clocks across
   * all client IDs.
   */
  clockSum(state: Uint8Array): number;
}

/**
 * A live editing surface backed by the Codec's
 * internal CRDT document. Editors bind to the
 * opaque `handle`. External code never touches
 * the underlying CRDT type directly.
 */
export interface CodecSurface {
  /** The live editing surface (e.g. Y.Doc for
   *  Yjs). Codec-internal type exposed as opaque
   *  handle — the editor component casts it. */
  readonly handle: unknown;

  /** Apply a remote edit's payload to the
   *  surface. Does NOT trigger onLocalEdit. */
  applyEdit(payload: Uint8Array): void;

  /** Apply a full state (from State view fold)
   *  to reset the surface. Does NOT trigger
   *  onLocalEdit. */
  applyState(state: Uint8Array): void;

  /** Register callback for local edits produced
   *  on the surface (user typing). Returns
   *  unsubscribe function. */
  onLocalEdit(cb: (payload: Uint8Array) => void): () => void;

  /** Clean up the surface. */
  destroy(): void;
}
