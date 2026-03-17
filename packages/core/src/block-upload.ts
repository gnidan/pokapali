/**
 * Upload a block to relay HTTPS endpoints via POST.
 *
 * Used when a snapshot block exceeds
 * MAX_INLINE_BLOCK_BYTES and cannot be inlined in
 * GossipSub. Retries with exponential backoff if all
 * relays fail on the first pass.
 */

import type { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("block-upload");

const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export interface UploadOptions {
  signal?: AbortSignal;
  maxRetries?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Try each relay URL once. Returns true on first
 * success.
 */
async function tryAllRelays(
  cid: CID,
  block: Uint8Array,
  httpUrls: string[],
): Promise<boolean> {
  const cidStr = cid.toString();
  for (const baseUrl of httpUrls) {
    try {
      const resp = await fetch(`${baseUrl}/block/${cidStr}`, {
        method: "POST",
        body: block.buffer.slice(
          block.byteOffset,
          block.byteOffset + block.byteLength,
        ) as ArrayBuffer,
        headers: {
          "Content-Type": "application/octet-stream",
        },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (resp.ok) {
        log.debug("uploaded block", cidStr.slice(0, 16) + "...", "to", baseUrl);
        return true;
      }
      log.debug("upload rejected by", baseUrl, resp.status);
    } catch (err) {
      log.debug("upload failed for", baseUrl, (err as Error)?.message ?? err);
    }
  }
  return false;
}

/**
 * Upload a block to any available relay, retrying
 * with exponential backoff if all relays fail.
 *
 * Returns true if at least one relay accepted the
 * block within the retry budget.
 */
export async function uploadBlock(
  cid: CID,
  block: Uint8Array,
  httpUrls: string[],
  options?: UploadOptions,
): Promise<boolean> {
  if (httpUrls.length === 0) return false;

  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  const { signal } = options ?? {};

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) return false;

    if (attempt > 0) {
      const delay = Math.min(
        INITIAL_DELAY_MS * 2 ** (attempt - 1),
        MAX_DELAY_MS,
      );
      log.debug(
        "block upload retry",
        attempt,
        "of",
        maxRetries,
        "in",
        delay + "ms",
      );
      try {
        await sleep(delay, signal);
      } catch {
        return false; // aborted during sleep
      }
    }

    const ok = await tryAllRelays(cid, block, httpUrls);
    if (ok) return true;
  }

  log.warn(
    "block upload failed after",
    maxRetries + 1,
    "attempts for",
    cid.toString().slice(0, 16) + "...",
  );
  return false;
}
