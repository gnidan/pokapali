/**
 * block-resolver.ts — Unified block resolution layer.
 *
 * Single abstraction for getting and storing blocks
 * across all layers: in-memory cache, IDB blockstore,
 * HTTP pinner endpoints, and Helia bitswap.
 *
 * Replaces scattered dual-write patterns (snapshotLC
 * blocks Map + helia.blockstore.put) with one `put()`
 * that writes to both layers.
 */

import type { CID } from "multiformats/cid";
import { fetchBlock } from "./fetch-block.js";
import type { BlockGetter } from "./fetch-block.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("block-resolver");

export interface BlockResolver {
  /** Resolve a block: memory → IDB → HTTP → bitswap.
   *  Never throws — returns null on miss. */
  get(cid: CID): Promise<Uint8Array | null>;

  /** Memory-only synchronous lookup. For hot-path
   *  callers (announce, reannounce, interpreter
   *  fast-path). */
  getCached(cid: CID): Uint8Array | null;

  /** Store in memory (sync) + IDB (fire-and-forget).
   *  Block is immediately available via getCached()
   *  after put() returns. */
  put(cid: CID, block: Uint8Array): void;
}

export interface BlockResolverOptions {
  getHelia: () => BlockGetter;
  httpUrls: () => string[];
  /** Called when an IDB blockstore.put() fails.
   *  Lets callers surface persistence errors to
   *  consumers instead of silently swallowing. */
  onWriteError?: (err: unknown) => void;
}

const NEGATIVE_CACHE_TTL_MS = 60_000;

export function createBlockResolver(opts: BlockResolverOptions): BlockResolver {
  const cache = new Map<string, Uint8Array>();
  const negativeCache = new Map<string, number>();

  return {
    async get(cid) {
      const key = cid.toString();

      // Layer 1: in-memory cache
      const cached = cache.get(key);
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
      // (fetchBlock handles all three internally)
      try {
        const helia = opts.getHelia();
        const block = await fetchBlock(helia, cid, {
          httpUrls: opts.httpUrls(),
          retries: 2,
          baseMs: 1_000,
        });
        if (block && block.length > 0) {
          cache.set(key, block);
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
      return cache.get(cid.toString()) ?? null;
    },

    put(cid, block) {
      if (block.length === 0) return;
      const key = cid.toString();
      cache.set(key, block);

      // Fire-and-forget IDB persistence
      try {
        const helia = opts.getHelia();
        if (helia.blockstore.put) {
          Promise.resolve(helia.blockstore.put(cid, block)).catch(
            (err: unknown) => {
              log.warn("blockstore.put failed:", err);
              opts.onWriteError?.(err);
            },
          );
        }
      } catch (err) {
        log.debug("IDB put skipped:", err);
        opts.onWriteError?.(err);
      }
    },
  };
}
