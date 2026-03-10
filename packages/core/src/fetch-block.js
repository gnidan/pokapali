import { createLogger } from "@pokapali/log";
const log = createLogger("fetch-block");
const DEFAULT_RETRIES = 6;
const DEFAULT_BASE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
export async function fetchBlock(helia, cid, options) {
    const retries = options?.retries ?? DEFAULT_RETRIES;
    const baseMs = options?.baseMs ?? DEFAULT_BASE_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let i = 0; i <= retries; i++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const block = await helia
                    .blockstore.get(cid, {
                    signal: ctrl.signal,
                });
                return block;
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch (err) {
            if (i === retries)
                throw err;
            const delay = baseMs * 2 ** i;
            log.debug(`retry ${i + 1}/${retries}` +
                ` in ${delay}ms for`, cid.toString().slice(0, 16) + "...");
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error("unreachable");
}
//# sourceMappingURL=fetch-block.js.map