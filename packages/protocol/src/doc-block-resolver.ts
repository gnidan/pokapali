/**
 * doc-block-resolver.ts — Layered BlockResolver (A2).
 *
 * Memory tier:  LRU cache (byte-budget bounded).
 * Persist tier: IDB via Helia blockstore.
 * Remote tier:  HTTP pinners → Helia bitswap.
 *
 * Exports `createDocBlockResolver()`, which replaces the
 * unbounded-Map `createBlockResolver()` from core for
 * production use. Core's version remains as the simpler
 * default; this module adds:
 *
 *   - LRU eviction with 10 MB default budget
 *   - knownCids: persistent set of all CIDs in IDB
 *   - memoryOnlyCids: CIDs held only in LRU (IDB
 *     write failed — quota, etc.)
 *   - has(cid): LRU ∪ knownCids (memoryOnly covered
 *     by LRU while alive; onEvict cleans stale refs)
 *   - ready / hydrated: IDB scan lifecycle
 *   - onWriteError(cid, err): callback for FailureStore
 *   - onResolved(cid): callback for recovery tracking
 *
 * Invariant: knownCids ∩ memoryOnlyCids = ∅.
 * A CID moves from memoryOnly → known once a retry
 * succeeds, or is removed from memoryOnly on LRU
 * eviction.
 *
 * Strict layering: protocol imports from core. Core
 * never imports from protocol.
 */

import type { CID } from "multiformats/cid";
import type { BlockResolver } from "@pokapali/core/block-resolver";
import { fetchBlock } from "@pokapali/core/fetch-block";
import type { BlockGetter } from "@pokapali/core/fetch-block";
import { createLogger } from "@pokapali/log";
import { createLruCache } from "./lru-cache.js";
import type { LruCache } from "./lru-cache.js";

const log = createLogger("doc-block-resolver");

const DEFAULT_LRU_BYTES = 10 * 1024 * 1024; // 10 MB
const NEGATIVE_CACHE_TTL_MS = 60_000;

export interface DocBlockResolver extends BlockResolver {
  /** True if cid is in LRU (memory) or persisted
   *  (IDB knownCids). memoryOnly CIDs are covered by
   *  LRU while alive; LRU eviction cleans stale refs.
   *  Does NOT promote in LRU. */
  has(cid: CID): boolean;

  /** CIDs confirmed persisted in IDB. Populated during
   *  hydration, updated on successful put(). */
  readonly knownCids: ReadonlySet<string>;

  /** CIDs held only in LRU — IDB write failed or
   *  hasn't been attempted yet. Disjoint with
   *  knownCids. Eviction from LRU removes from this
   *  set (block is lost). */
  readonly memoryOnlyCids: ReadonlySet<string>;

  /** Resolves when IDB hydration completes
   *  (knownCids populated). */
  readonly ready: Promise<void>;

  /** True after IDB hydration has finished. */
  readonly hydrated: boolean;
}

/** Async iterator over CID/block pairs, used for
 *  IDB hydration. Matches Helia's blockstore.getAll()
 *  return type. */
export interface BlockPair {
  cid: CID;
  block: Uint8Array;
}

export interface DocBlockResolverOptions {
  getHelia: () => BlockGetter;
  httpUrls: () => string[];

  /** Enumerate all persisted CIDs on startup. If
   *  omitted, knownCids starts empty and is populated
   *  only by put() calls. Typical impl: return
   *  helia.blockstore.getAll(). */
  enumeratePersistedCids?: () => AsyncIterable<BlockPair>;

  /** Byte budget for the in-memory LRU tier.
   *  Default: 10 MB. */
  lruBytes?: number;

  /** Called when an IDB put() fails. The CID is held
   *  in memory only until LRU eviction.
   *  Ingress layer uses this to write FailureStore
   *  records. */
  onWriteError?: (cid: CID, err: unknown) => void;

  /** Called when a CID that was previously memory-only
   *  is successfully persisted to IDB (e.g., retry
   *  succeeded). Ingress layer uses this to mark
   *  FailureStore records as recovered. */
  onResolved?: (cid: CID) => void;
}

export function createDocBlockResolver(
  opts: DocBlockResolverOptions,
): DocBlockResolver {
  const knownCids = new Set<string>();
  const memoryOnlyCids = new Set<string>();
  const lru: LruCache = createLruCache({
    maxBytes: opts.lruBytes ?? DEFAULT_LRU_BYTES,
    onEvict(key) {
      // If a memoryOnly CID is evicted from LRU,
      // it's gone — no IDB backup. Remove from
      // memoryOnlyCids so has() stops advertising it.
      memoryOnlyCids.delete(key);
    },
  });
  const negativeCache = new Map<string, number>();

  let _hydrated = false;
  let _resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    _resolveReady = resolve;
  });

  // --- Hydration: scan IDB to populate knownCids ---

  function hydrate(): void {
    if (!opts.enumeratePersistedCids) {
      // No enumerator provided; knownCids starts empty,
      // populated only by successful put() calls.
      _hydrated = true;
      _resolveReady();
      return;
    }

    const enumerate = opts.enumeratePersistedCids;
    (async () => {
      try {
        for await (const pair of enumerate()) {
          knownCids.add(pair.cid.toString());
        }
      } catch (err) {
        log.warn("hydration scan failed:", err);
      } finally {
        _hydrated = true;
        _resolveReady();
      }
    })();
  }

  // Start hydration immediately on construction.
  hydrate();

  // --- Helpers ---

  function persistToIdb(cid: CID, block: Uint8Array): void {
    const key = cid.toString();
    try {
      const helia = opts.getHelia();
      if (helia.blockstore.put) {
        Promise.resolve(helia.blockstore.put(cid, block)).then(
          () => {
            // Success: promote from memoryOnly → known
            if (memoryOnlyCids.delete(key)) {
              knownCids.add(key);
              opts.onResolved?.(cid);
            } else {
              knownCids.add(key);
            }
          },
          (err: unknown) => {
            log.warn("blockstore.put failed:", err);
            // Keep in memoryOnly; caller decides recovery
            memoryOnlyCids.add(key);
            // Enforce disjoint invariant
            knownCids.delete(key);
            opts.onWriteError?.(cid, err);
          },
        );
      }
    } catch (err) {
      log.debug("IDB put skipped:", err);
      memoryOnlyCids.add(key);
      knownCids.delete(key);
      opts.onWriteError?.(cid, err);
    }
  }

  return {
    async get(cid) {
      const key = cid.toString();

      // Layer 1: LRU memory cache
      const cached = lru.get(key);
      if (cached) return cached;

      // Negative cache: skip re-fetch within TTL
      const missAt = negativeCache.get(key);
      if (missAt !== undefined) {
        if (Date.now() - missAt < NEGATIVE_CACHE_TTL_MS) {
          return null;
        }
        negativeCache.delete(key);
      }

      // Layer 2+3+4: IDB → HTTP → bitswap
      try {
        const helia = opts.getHelia();
        const block = await fetchBlock(helia, cid, {
          httpUrls: opts.httpUrls(),
          retries: 2,
          baseMs: 1_000,
        });
        if (block && block.length > 0) {
          lru.set(key, block);
          negativeCache.delete(key);
          return block;
        }
        negativeCache.set(key, Date.now());
        return null;
      } catch (err) {
        log.debug("block resolution failed for", key.slice(0, 16) + "...", err);
        negativeCache.set(key, Date.now());
        return null;
      }
    },

    getCached(cid) {
      return lru.get(cid.toString()) ?? null;
    },

    put(cid, block) {
      if (block.length === 0) return;
      const key = cid.toString();
      lru.set(key, block);
      persistToIdb(cid, block);
    },

    has(cid) {
      const key = cid.toString();
      // memoryOnly CIDs are always in LRU while alive,
      // so lru.has() covers them. Once evicted from LRU,
      // onEvict cleans memoryOnlyCids — has() correctly
      // returns false for unrecoverable blocks.
      return lru.has(key) || knownCids.has(key);
    },

    get knownCids() {
      return knownCids as ReadonlySet<string>;
    },

    get memoryOnlyCids() {
      return memoryOnlyCids as ReadonlySet<string>;
    },

    get ready() {
      return ready;
    },

    get hydrated() {
      return _hydrated;
    },
  };
}
