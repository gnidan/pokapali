import { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("fetch-version-history");

const HTTP_TIMEOUT_MS = 10_000;

export interface VersionEntry {
  cid: CID;
  seq: number;
  ts: number;
}

/**
 * Fetch version history from a pinner's HTTP endpoint,
 * falling back to local chain walking if unreachable.
 *
 * Returns entries newest-first. Never throws — returns
 * whatever entries are available.
 */
export async function fetchVersionHistory(
  pinnerUrls: string[],
  ipnsName: string,
  localHistory: () => Promise<VersionEntry[]>,
): Promise<VersionEntry[]> {
  for (const baseUrl of pinnerUrls) {
    try {
      const url = `${baseUrl}/history/${ipnsName}`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.debug("pinner history", resp.status, "from", baseUrl);
        continue;
      }

      const data = await resp.json();
      if (!Array.isArray(data)) {
        log.debug("pinner history: unexpected format");
        continue;
      }

      const entries: VersionEntry[] = [];
      for (const item of data) {
        if (typeof item.cid !== "string" || typeof item.ts !== "number") {
          continue; // skip malformed entries
        }
        try {
          entries.push({
            cid: CID.parse(item.cid),
            seq: typeof item.seq === "number" ? item.seq : 0,
            ts: item.ts,
          });
        } catch {
          // skip unparseable CIDs
          log.debug("skip unparseable CID:", item.cid);
        }
      }

      if (entries.length > 0) {
        log.debug(`got ${entries.length} entries from`, baseUrl);
        return entries;
      }
    } catch (err) {
      log.debug("pinner history failed:", (err as Error)?.message ?? err);
    }
  }

  // Fallback: local chain walking
  try {
    return await localHistory();
  } catch (err) {
    log.debug("local history fallback failed:", (err as Error)?.message ?? err);
    return [];
  }
}
