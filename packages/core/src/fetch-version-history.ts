import { CID } from "multiformats/cid";
import { createLogger } from "@pokapali/log";

const log = createLogger("fetch-version-history");

const HTTP_TIMEOUT_MS = 10_000;

const validTiers = new Set(["tip", "full", "hourly", "daily"]);

export type VersionTier = "tip" | "full" | "hourly" | "daily";

export interface VersionEntry {
  cid: CID;
  seq: number;
  ts: number;
  /** Retention tier (present when pinner provides
   *  retention policy metadata). */
  tier?: VersionTier;
  /** Epoch ms when this version expires under its
   *  current tier. `null` for the tip (never
   *  expires). `undefined` when unknown. */
  expiresAt?: number | null;
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

      // Accept both the enriched `{ versions: [...] }`
      // format and the legacy raw-array format.
      const items: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.versions)
          ? data.versions
          : [];
      if (items.length === 0 && !Array.isArray(data)) {
        log.debug("pinner history: unexpected format");
        continue;
      }

      const entries: VersionEntry[] = [];
      for (const item of items) {
        const rec = item as Record<string, unknown>;
        if (typeof rec.cid !== "string" || typeof rec.ts !== "number") {
          continue; // skip malformed entries
        }
        try {
          const entry: VersionEntry = {
            cid: CID.parse(rec.cid),
            seq: typeof rec.seq === "number" ? rec.seq : 0,
            ts: rec.ts,
          };
          if (typeof rec.tier === "string" && validTiers.has(rec.tier)) {
            entry.tier = rec.tier as VersionTier;
          }
          if (rec.expiresAt === null || typeof rec.expiresAt === "number") {
            entry.expiresAt = rec.expiresAt as number | null;
          }
          entries.push(entry);
        } catch {
          // skip unparseable CIDs
          log.debug("skip unparseable CID:", rec.cid);
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
