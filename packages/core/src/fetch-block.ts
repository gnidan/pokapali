import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createLogger } from "@pokapali/log";

const log = createLogger("fetch-block");

/**
 * Coerce a value to a plain Uint8Array. Handles
 * Buffer, ArrayBuffer, and typed-array subclasses
 * that fail `instanceof Uint8Array` in dag-cbor.
 */
export function ensureUint8Array(
  data: Uint8Array | ArrayBuffer | ArrayBufferView,
): Uint8Array {
  if (data instanceof Uint8Array && data.constructor === Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  // Fallback: copy
  return new Uint8Array(data as Uint8Array);
}

const DEFAULT_RETRIES = 6;
const DEFAULT_BASE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 15_000;

export interface FetchBlockOptions {
  retries?: number;
  baseMs?: number;
  timeoutMs?: number;
  /** HTTP block endpoint URLs to try as fallback
   *  after all blockstore retries fail. */
  httpUrls?: string[];
}

export interface BlockGetter {
  blockstore: {
    get(
      cid: CID,
      opts?: { signal?: AbortSignal; offline?: boolean },
    ): Promise<Uint8Array> | Uint8Array;
    put?(cid: CID, block: Uint8Array): Promise<CID> | CID | void;
  };
}

/**
 * Helper: single offline blockstore.get attempt.
 * Returns the block or undefined on miss.
 */
async function tryOffline(
  helia: BlockGetter,
  cid: CID,
  timeoutMs: number,
): Promise<Uint8Array | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const raw = await helia.blockstore.get(cid, {
        signal: ctrl.signal,
        offline: true,
      });
      const block = ensureUint8Array(raw);
      if (block.length === 0) return undefined;
      return block;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/**
 * Helper: try HTTP block endpoints. Returns the
 * block or undefined if all fail / 404.
 */
async function tryHttp(
  cid: CID,
  urls: string[],
): Promise<Uint8Array | undefined> {
  const cidStr = cid.toString();
  for (const baseUrl of urls) {
    try {
      const resp = await fetch(`${baseUrl}/block/${cidStr}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length === 0) {
        log.debug("empty block from HTTP", baseUrl);
        continue;
      }
      const hash = await sha256.digest(bytes);
      const verified = CID.createV1(cid.code, hash);
      if (!verified.equals(cid)) {
        log.warn("HTTP block CID mismatch from", baseUrl);
        continue;
      }
      return bytes;
    } catch (err) {
      log.debug("HTTP fallback failed for", baseUrl, err);
      continue;
    }
  }
  return undefined;
}

/**
 * Fetch a block with layered fallback:
 *
 *  1. Offline IDB check — instant if cached
 *  2. HTTP pinner endpoints — fast network fetch
 *  3. Helia bitswap (no offline flag) — slow but
 *     reliable last resort with retry + backoff
 *
 * Phase 3 is the only phase that retries. Phases 1
 * and 2 are single-shot fast checks.
 */
export async function fetchBlock(
  helia: BlockGetter,
  cid: CID,
  options?: FetchBlockOptions,
): Promise<Uint8Array> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const baseMs = options?.baseMs ?? DEFAULT_BASE_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cidShort = cid.toString().slice(0, 16) + "...";

  // Phase 1: offline IDB — instant local check.
  // Skips Helia's bitswap/gateway network layer.
  const cached = await tryOffline(helia, cid, timeoutMs);
  if (cached) return cached;

  // Phase 2: HTTP pinner endpoints — fast network.
  const urls = options?.httpUrls ?? [];
  if (urls.length > 0) {
    const httpBlock = await tryHttp(cid, urls);
    if (httpBlock) return httpBlock;
  }

  // Phase 3: Helia bitswap — slow last resort.
  // Without offline flag, Helia's NetworkedStorage
  // triggers bitswap + trustless gateway retrieval.
  // Retry with exponential backoff.
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const raw = await helia.blockstore.get(cid, {
          signal: ctrl.signal,
        });
        const block = ensureUint8Array(raw);
        if (block.length === 0) {
          throw new Error("empty block from blockstore");
        }
        return block;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        const delay = baseMs * 2 ** i;
        log.debug(
          `bitswap retry ${i + 1}/${retries}` + ` in ${delay}ms for`,
          cidShort,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}
