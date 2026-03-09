import { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("fetch-block");

const DEFAULT_RETRIES = 6;
const DEFAULT_BASE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchBlockOptions {
  retries?: number;
  baseMs?: number;
  timeoutMs?: number;
}

export interface BlockGetter {
  blockstore: {
    get(cid: CID, opts?: { signal?: AbortSignal }):
      Promise<Uint8Array> | Uint8Array;
    put?(cid: CID, block: Uint8Array):
      Promise<CID> | CID | void;
  };
}

export async function fetchBlock(
  helia: BlockGetter,
  cid: CID,
  options?: FetchBlockOptions,
): Promise<Uint8Array> {
  const retries =
    options?.retries ?? DEFAULT_RETRIES;
  const baseMs =
    options?.baseMs ?? DEFAULT_BASE_MS;
  const timeoutMs =
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        timeoutMs,
      );
      try {
        const block: Uint8Array = await helia
          .blockstore.get(cid, {
            signal: ctrl.signal,
          });
        return block;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (i === retries) throw err;
      const delay = baseMs * 2 ** i;
      log.debug(
        `retry ${i + 1}/${retries}` +
          ` in ${delay}ms for`,
        cid.toString().slice(0, 16) + "...",
      );
      await new Promise(
        (r) => setTimeout(r, delay),
      );
    }
  }
  throw new Error("unreachable");
}
