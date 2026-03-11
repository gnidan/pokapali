/**
 * Upload a block to relay HTTPS endpoints via POST.
 *
 * Used when a snapshot block exceeds
 * MAX_INLINE_BLOCK_BYTES and cannot be inlined in
 * GossipSub. Best-effort: returns true if at least
 * one relay accepted the block.
 */

import type { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("block-upload");

const UPLOAD_TIMEOUT_MS = 30_000;

export async function uploadBlock(
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
        ),
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
