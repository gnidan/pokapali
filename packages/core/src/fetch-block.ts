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
      opts?: { signal?: AbortSignal },
    ): Promise<Uint8Array> | Uint8Array;
    put?(cid: CID, block: Uint8Array): Promise<CID> | CID | void;
  };
}

export async function fetchBlock(
  helia: BlockGetter,
  cid: CID,
  options?: FetchBlockOptions,
): Promise<Uint8Array> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const baseMs = options?.baseMs ?? DEFAULT_BASE_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let blockstoreErr: unknown;

  // Phase 1: blockstore retry loop
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const raw = await helia.blockstore.get(cid, {
          signal: ctrl.signal,
        });
        // IDBBlockstore may return a Buffer or
        // ArrayBuffer-backed view that fails
        // dag-cbor's instanceof Uint8Array check.
        // Coerce to a plain Uint8Array.
        const block = ensureUint8Array(raw);
        if (block.length === 0) {
          throw new Error("empty block from blockstore");
        }
        return block;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      blockstoreErr = err;
      if (i < retries) {
        const delay = baseMs * 2 ** i;
        log.debug(
          `retry ${i + 1}/${retries}` + ` in ${delay}ms for`,
          cid.toString().slice(0, 16) + "...",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // Phase 2: HTTP fallback
  const urls = options?.httpUrls ?? [];
  if (urls.length > 0) {
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

        // Verify content integrity
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
  }

  throw blockstoreErr;
}
