/**
 * fetch-tip.ts — HTTP tip fetcher for pinner
 * endpoints (GET /tip/:ipnsName).
 *
 * Fastest-path discovery: hits known pinner HTTP
 * URLs to get the current tip CID + inline block.
 * Falls back gracefully — never throws.
 */

import { CID } from "multiformats/cid";
import { base64ToUint8 } from "./announce.js";
import { createLogger } from "@pokapali/log";

const log = createLogger("fetch-tip");

const HTTP_TIMEOUT_MS = 10_000;

export interface TipResult {
  cid: CID;
  block: Uint8Array;
  seq: number;
  ts: number;
  guaranteeUntil?: number;
  retainUntil?: number;
}

/**
 * Fetch the current tip from pinner HTTP endpoints.
 *
 * Tries each URL in order. Returns the first
 * successful result, or null if all fail.
 * Never throws.
 */
export async function fetchTipFromPinners(
  pinnerUrls: string[],
  ipnsName: string,
  signal?: AbortSignal,
): Promise<TipResult | null> {
  for (const baseUrl of pinnerUrls) {
    try {
      const url = `${baseUrl}/tip/${ipnsName}`;
      const resp = await fetch(url, {
        signal: signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.debug("pinner tip", resp.status, "from", baseUrl);
        continue;
      }

      const data = await resp.json();

      if (typeof data?.cid !== "string" || typeof data?.block !== "string") {
        log.debug("pinner tip: unexpected format from", baseUrl);
        continue;
      }

      let cid: CID;
      try {
        cid = CID.parse(data.cid);
      } catch {
        log.debug("pinner tip: unparseable CID from", baseUrl);
        continue;
      }

      const block = base64ToUint8(data.block);
      if (block.length === 0) {
        log.debug("pinner tip: empty block from", baseUrl);
        continue;
      }

      const result: TipResult = {
        cid,
        block,
        seq: typeof data.seq === "number" ? data.seq : 0,
        ts: typeof data.ts === "number" ? data.ts : Date.now(),
      };

      if (typeof data.guaranteeUntil === "number") {
        result.guaranteeUntil = data.guaranteeUntil;
      }
      if (typeof data.retainUntil === "number") {
        result.retainUntil = data.retainUntil;
      }

      log.debug(
        "got tip from",
        baseUrl,
        "cid=",
        cid.toString().slice(0, 16) + "...",
      );
      return result;
    } catch (err) {
      log.debug("pinner tip failed:", (err as Error)?.message ?? err);
    }
  }

  return null;
}
