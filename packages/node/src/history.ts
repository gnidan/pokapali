import { CID } from "multiformats/cid";

export interface SnapshotRecord {
  cid: string;
  ts: number;
}

export interface HistoryEntry {
  tip: SnapshotRecord | null;
  snapshots: SnapshotRecord[];
}

export interface RetentionConfig {
  fullResolutionMs: number;
  hourlyRetentionMs: number;
  dailyRetentionMs: number;
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface HistoryTracker {
  add(ipnsName: string, cid: CID, ts: number): void;
  prune(now?: number): CID[];
  thinSnapshots(ipnsName: string, config: RetentionConfig, now?: number): CID[];
  getTip(ipnsName: string): string | null;
  getHistory(ipnsName: string): SnapshotRecord[];
  getEntry(ipnsName: string): HistoryEntry | undefined;
  allNames(): string[];
  toJSON(): Record<string, HistoryEntry>;
  loadJSON(data: Record<string, HistoryEntry>): void;
}

export function createHistoryTracker(
  retentionMs: number = DEFAULT_RETENTION_MS,
): HistoryTracker {
  const entries = new Map<string, HistoryEntry>();

  return {
    add(ipnsName: string, cid: CID, ts: number): void {
      let entry = entries.get(ipnsName);
      if (!entry) {
        entry = { tip: null, snapshots: [] };
        entries.set(ipnsName, entry);
      }

      const cidStr = cid.toString();

      // Avoid duplicates
      if (entry.snapshots.some((s) => s.cid === cidStr)) {
        // Still update tip if newer
        if (!entry.tip || ts >= entry.tip.ts) {
          entry.tip = { cid: cidStr, ts };
        }
        return;
      }

      const record: SnapshotRecord = { cid: cidStr, ts };
      entry.snapshots.push(record);

      // Update tip if this is the newest
      if (!entry.tip || ts >= entry.tip.ts) {
        entry.tip = record;
      }
    },

    prune(now: number = Date.now()): CID[] {
      const cutoff = now - retentionMs;
      const removed: CID[] = [];

      for (const [, entry] of entries) {
        const tipCid = entry.tip?.cid;
        const kept: SnapshotRecord[] = [];

        for (const snap of entry.snapshots) {
          if (snap.ts >= cutoff || snap.cid === tipCid) {
            kept.push(snap);
          } else {
            removed.push(CID.parse(snap.cid));
          }
        }

        entry.snapshots = kept;
      }

      return removed;
    },

    thinSnapshots(
      ipnsName: string,
      config: RetentionConfig,
      now: number = Date.now(),
    ): CID[] {
      const entry = entries.get(ipnsName);
      if (!entry) return [];

      const tipCid = entry.tip?.cid;
      const removed: CID[] = [];

      // Collect which snapshots to keep per bucket.
      // For hourly/daily tiers, keep the latest ts
      // in each bucket.
      const hourlyBest = new Map<number, SnapshotRecord>();
      const dailyBest = new Map<number, SnapshotRecord>();

      // Classify each snapshot into a tier
      const fullTier: SnapshotRecord[] = [];
      const hourlyTier: SnapshotRecord[] = [];
      const dailyTier: SnapshotRecord[] = [];
      const pruneTier: SnapshotRecord[] = [];

      for (const snap of entry.snapshots) {
        // Tip is always kept
        if (snap.cid === tipCid) {
          fullTier.push(snap);
          continue;
        }

        const age = now - snap.ts;
        if (age < config.fullResolutionMs) {
          fullTier.push(snap);
        } else if (age < config.hourlyRetentionMs) {
          hourlyTier.push(snap);
        } else if (age < config.dailyRetentionMs) {
          dailyTier.push(snap);
        } else {
          pruneTier.push(snap);
        }
      }

      // Find best (latest ts) per hour bucket
      for (const snap of hourlyTier) {
        const bucket = Math.floor(snap.ts / MS_PER_HOUR);
        const best = hourlyBest.get(bucket);
        if (!best || snap.ts > best.ts) {
          hourlyBest.set(bucket, snap);
        }
      }

      // Find best (latest ts) per day bucket
      for (const snap of dailyTier) {
        const bucket = Math.floor(snap.ts / MS_PER_DAY);
        const best = dailyBest.get(bucket);
        if (!best || snap.ts > best.ts) {
          dailyBest.set(bucket, snap);
        }
      }

      const kept: SnapshotRecord[] = [...fullTier];
      const hourlyKeptCids = new Set(
        [...hourlyBest.values()].map((s) => s.cid),
      );
      const dailyKeptCids = new Set([...dailyBest.values()].map((s) => s.cid));

      for (const snap of hourlyTier) {
        if (hourlyKeptCids.has(snap.cid)) {
          kept.push(snap);
        } else {
          removed.push(CID.parse(snap.cid));
        }
      }

      for (const snap of dailyTier) {
        if (dailyKeptCids.has(snap.cid)) {
          kept.push(snap);
        } else {
          removed.push(CID.parse(snap.cid));
        }
      }

      for (const snap of pruneTier) {
        removed.push(CID.parse(snap.cid));
      }

      entry.snapshots = kept;
      return removed;
    },

    getTip(ipnsName: string): string | null {
      const entry = entries.get(ipnsName);
      return entry?.tip?.cid ?? null;
    },

    getHistory(ipnsName: string): SnapshotRecord[] {
      const entry = entries.get(ipnsName);
      return entry ? [...entry.snapshots] : [];
    },

    getEntry(ipnsName: string): HistoryEntry | undefined {
      return entries.get(ipnsName);
    },

    allNames(): string[] {
      return [...entries.keys()];
    },

    toJSON(): Record<string, HistoryEntry> {
      return Object.fromEntries(entries);
    },

    loadJSON(data: Record<string, HistoryEntry>): void {
      entries.clear();
      for (const [name, entry] of Object.entries(data)) {
        entries.set(name, entry);
      }
    },
  };
}
