/**
 * stub-block-resolver.ts — Test harness for BlockResolver.
 *
 * Two-tier in-memory stub honoring the BlockResolver
 * contract defined in `../block-resolver.ts`. The stub
 * models memory + persistence as two Maps (both in-
 * process; "persistence" survives memory eviction).
 *
 * Eviction and failure are test-controlled, not policy-
 * driven. Tests exercise specific scenarios rather than
 * chasing an LRU algorithm.
 *
 * Shared by A-track consumer PRs (A3 ingest, A4 wiring)
 * and by D-track integration tests. The real impl lives
 * in `packages/protocol/src/doc-block-resolver.ts` (S54
 * Track A2); a parity test there asserts identical
 * observable behavior.
 *
 * Stub-sync policy: changes to the `BlockResolver`
 * interface or real impl require stub + parity updates
 * in the same PR. No trailing "update stub" IOUs.
 * Owner pattern: core touches real impl → core updates
 * stub/parity → testing reviews. Stub-vs-real divergence
 * = parity-test build break, which is the structural
 * mechanism preventing stub drift over time.
 */

import { sha256 } from "multiformats/hashes/sha2";
import type { CID } from "multiformats/cid";
import type { BlockResolver } from "../block-resolver.js";

/** Failure modes for `put()` injection. Modeled on
 *  real-world IDB failure classes. */
export type PutFailureType = "quota" | "unavailable";

export interface StubBlockResolverOptions {
  /** Pre-seed with known blocks. Each becomes present
   *  in both the memory and persistence tiers. */
  initialBlocks?: Array<[CID, Uint8Array]>;
}

export interface StubBlockResolver extends BlockResolver {
  // --- Inspection ---

  /** Base32-string CIDs currently stored (memory ∪
   *  persistence). Equivalent to has()-true for tests
   *  that want to enumerate. */
  readonly storedCids: ReadonlySet<string>;

  /** Base32-string CIDs present in the memory tier but
   *  NOT persistence. Models the memory-only fallback
   *  path after IDB put failures (quota/unavailable).
   *  These blocks are lost on session restart in the
   *  real impl; the stub keeps them indefinitely so
   *  tests can assert behavior. */
  readonly memoryOnlyCids: ReadonlySet<string>;

  /** Count of put() calls since construction. */
  readonly putCount: number;

  /** Count of getCached() calls since construction.
   *  Useful to assert catalog building doesn't thrash. */
  readonly getCachedCount: number;

  // --- Test actions ---

  /** Remove a CID from the memory tier but keep it in
   *  persistence. Subsequent getCached(cid) returns null
   *  until a re-populate; has(cid) stays true; async
   *  get(cid) returns the block. Models LRU eviction. */
  simulateMemoryEviction(cid: CID): void;

  /** Drop a CID from both tiers entirely. Subsequent
   *  has(cid) returns false. Models catastrophic loss
   *  (disk corruption, user clears site data). */
  simulateBlockLoss(cid: CID): void;

  /** Cause the NEXT put() call to fail with the given
   *  error type (no persistence write; memory-only
   *  fallback). Auto-resets after one put.
   *
   *  Note: "quota" and "unavailable" currently produce
   *  identical observable behavior in the stub (both
   *  land the block memory-only). The real impl may
   *  differ per failure type (e.g., surface quota to
   *  telemetry differently) — the A2 parity test is the
   *  mechanism that will catch any observable drift. */
  simulatePutFailure(type: PutFailureType): void;

  /** Cause ALL subsequent put() calls to fail until
   *  cleared. Same observable-equivalence caveat as
   *  `simulatePutFailure` applies across both failure
   *  types. */
  simulatePersistentPutFailure(type: PutFailureType): void;

  /** Reset put-failure injection. */
  clearPutFailure(): void;
}

export function createStubBlockResolver(
  opts?: StubBlockResolverOptions,
): StubBlockResolver {
  // Two in-process tiers. "persistence" outlives memory
  // eviction; memoryOnly tracks the IDB-write-failure
  // fallback set.
  const memory = new Map<string, Uint8Array>();
  const persistence = new Map<string, Uint8Array>();
  const memoryOnly = new Set<string>();

  let putCount = 0;
  let getCachedCount = 0;
  let failureInjection: {
    type: PutFailureType;
    oneShot: boolean;
  } | null = null;

  // Seed both tiers from initialBlocks.
  if (opts?.initialBlocks) {
    for (const [cid, data] of opts.initialBlocks) {
      const key = cid.toString();
      memory.set(key, data);
      persistence.set(key, data);
    }
  }

  const storedView = new Set<string>();
  const memoryOnlyView = memoryOnly;

  const refreshStoredView = (): void => {
    storedView.clear();
    for (const key of memory.keys()) storedView.add(key);
    for (const key of persistence.keys()) storedView.add(key);
  };
  refreshStoredView();

  return {
    // --- BlockResolver surface ---

    async get(cid) {
      const key = cid.toString();
      return memory.get(key) ?? persistence.get(key) ?? null;
    },

    has(cid) {
      return storedView.has(cid.toString());
    },

    getCached(cid) {
      getCachedCount++;
      return memory.get(cid.toString()) ?? null;
    },

    put(cid, data) {
      putCount++;
      const key = cid.toString();
      // Memory tier always accepts.
      memory.set(key, data);

      if (failureInjection) {
        // Persistence write fails; memory-only fallback.
        memoryOnly.add(key);
        if (failureInjection.oneShot) failureInjection = null;
      } else {
        persistence.set(key, data);
        memoryOnly.delete(key);
      }
      refreshStoredView();
    },

    // --- Inspection ---

    get storedCids() {
      return storedView;
    },

    get memoryOnlyCids() {
      return memoryOnlyView;
    },

    get putCount() {
      return putCount;
    },

    get getCachedCount() {
      return getCachedCount;
    },

    // --- Test actions ---

    simulateMemoryEviction(cid) {
      const key = cid.toString();
      memory.delete(key);
      // If the block was memory-only, eviction means
      // it's gone entirely — drop from memoryOnly too.
      memoryOnly.delete(key);
      refreshStoredView();
    },

    simulateBlockLoss(cid) {
      const key = cid.toString();
      memory.delete(key);
      persistence.delete(key);
      memoryOnly.delete(key);
      refreshStoredView();
    },

    simulatePutFailure(type) {
      failureInjection = { type, oneShot: true };
    },

    simulatePersistentPutFailure(type) {
      failureInjection = { type, oneShot: false };
    },

    clearPutFailure() {
      failureInjection = null;
    },
  };
}

/** Verify that a block's bytes hash to the given CID.
 *  Convenience helper for tests that want to assert
 *  CID/block consistency after a transfer. */
export async function cidMatchesBlock(
  cid: CID,
  data: Uint8Array,
): Promise<boolean> {
  const digest = await sha256.digest(data);
  const a = cid.multihash.digest;
  const b = digest.digest;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
