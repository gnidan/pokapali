import { CID } from "multiformats/cid";

export interface SnapshotRecord {
  cid: string;
  ts: number;
}

export interface HistoryEntry {
  tip: SnapshotRecord | null;
  snapshots: SnapshotRecord[];
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface HistoryTracker {
  add(ipnsName: string, cid: CID, ts: number): void;
  prune(now?: number): CID[];
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
