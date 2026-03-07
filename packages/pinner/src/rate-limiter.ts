export interface RateLimiterConfig {
  maxSnapshotsPerHour: number;
  maxBlockSizeBytes: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxSnapshotsPerHour: 60,
  maxBlockSizeBytes: 5_000_000,
};

interface Entry {
  timestamps: number[];
}

export interface RateLimiter {
  check(
    ipnsName: string,
    blockSize: number,
    now?: number
  ): { allowed: boolean; reason?: string };
  record(ipnsName: string, now?: number): void;
}

export function createRateLimiter(
  config: RateLimiterConfig = DEFAULT_RATE_LIMITS
): RateLimiter {
  const entries = new Map<string, Entry>();

  function getEntry(ipnsName: string): Entry {
    let entry = entries.get(ipnsName);
    if (!entry) {
      entry = { timestamps: [] };
      entries.set(ipnsName, entry);
    }
    return entry;
  }

  function pruneOld(entry: Entry, now: number): void {
    const cutoff = now - 3_600_000;
    entry.timestamps = entry.timestamps.filter(
      (t) => t > cutoff
    );
  }

  return {
    check(
      ipnsName: string,
      blockSize: number,
      now: number = Date.now()
    ): { allowed: boolean; reason?: string } {
      if (blockSize > config.maxBlockSizeBytes) {
        return {
          allowed: false,
          reason: `block size ${blockSize} exceeds limit`
            + ` ${config.maxBlockSizeBytes}`,
        };
      }

      const entry = getEntry(ipnsName);
      pruneOld(entry, now);

      if (
        entry.timestamps.length >= config.maxSnapshotsPerHour
      ) {
        return {
          allowed: false,
          reason: `rate limit exceeded:`
            + ` ${entry.timestamps.length}`
            + `/${config.maxSnapshotsPerHour} per hour`,
        };
      }

      return { allowed: true };
    },

    record(
      ipnsName: string,
      now: number = Date.now()
    ): void {
      const entry = getEntry(ipnsName);
      pruneOld(entry, now);
      entry.timestamps.push(now);
    },
  };
}
