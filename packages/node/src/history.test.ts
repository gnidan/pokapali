import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createHistoryTracker, type RetentionConfig } from "./history.js";

async function makeCid(data: string): Promise<CID> {
  const bytes = new TextEncoder().encode(data);
  const hash = await sha256.digest(bytes);
  return CID.create(1, 0x55, hash);
}

describe("HistoryTracker", () => {
  it("tracks snapshots per name", async () => {
    const tracker = createHistoryTracker();
    const cid = await makeCid("block1");
    tracker.add("name1", cid, 1000);

    const entry = tracker.getEntry("name1");
    expect(entry).toBeDefined();
    expect(entry!.snapshots).toHaveLength(1);
    expect(entry!.tip!.cid).toBe(cid.toString());
  });

  it("updates tip to newest snapshot", async () => {
    const tracker = createHistoryTracker();
    const cid1 = await makeCid("block1");
    const cid2 = await makeCid("block2");

    tracker.add("name1", cid1, 1000);
    tracker.add("name1", cid2, 2000);

    const entry = tracker.getEntry("name1");
    expect(entry!.tip!.cid).toBe(cid2.toString());
    expect(entry!.snapshots).toHaveLength(2);
  });

  it("avoids duplicate CIDs", async () => {
    const tracker = createHistoryTracker();
    const cid = await makeCid("block1");

    tracker.add("name1", cid, 1000);
    tracker.add("name1", cid, 1000);

    const entry = tracker.getEntry("name1");
    expect(entry!.snapshots).toHaveLength(1);
  });

  it("prunes snapshots older than retention", async () => {
    // Use 1h retention for fast testing
    const tracker = createHistoryTracker(60 * 60_000);
    const old = await makeCid("old");
    const recent = await makeCid("recent");

    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    tracker.add("name1", old, dayAgo);
    tracker.add("name1", recent, now - 1000);

    const removed = tracker.prune(now);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.toString()).toBe(old.toString());

    const entry = tracker.getEntry("name1");
    expect(entry!.snapshots).toHaveLength(1);
    expect(entry!.snapshots[0]!.cid).toBe(recent.toString());
  });

  it("always keeps the tip even if old", async () => {
    const tracker = createHistoryTracker(60 * 60_000);
    const old = await makeCid("only-one");

    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    tracker.add("name1", old, dayAgo);

    const removed = tracker.prune(now);
    expect(removed).toHaveLength(0);

    const entry = tracker.getEntry("name1");
    expect(entry!.snapshots).toHaveLength(1);
  });

  it("serializes and restores state", async () => {
    const tracker = createHistoryTracker();
    const cid = await makeCid("block1");
    tracker.add("name1", cid, 1000);

    const json = tracker.toJSON();
    const tracker2 = createHistoryTracker();
    tracker2.loadJSON(json);

    const entry = tracker2.getEntry("name1");
    expect(entry).toBeDefined();
    expect(entry!.tip!.cid).toBe(cid.toString());
  });

  it("lists all tracked names", async () => {
    const tracker = createHistoryTracker();
    const cid1 = await makeCid("a");
    const cid2 = await makeCid("b");

    tracker.add("name1", cid1, 1000);
    tracker.add("name2", cid2, 2000);

    const names = tracker.allNames();
    expect(names).toContain("name1");
    expect(names).toContain("name2");
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const defaultConfig: RetentionConfig = {
  fullResolutionMs: 7 * DAY,
  hourlyRetentionMs: 14 * DAY,
  dailyRetentionMs: 30 * DAY,
};

describe("thinSnapshots", () => {
  it("keeps all snapshots within full-resolution tier", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Add 10 snapshots within the last 6 days
    const cids: CID[] = [];
    for (let i = 0; i < 10; i++) {
      const cid = await makeCid(`full-${i}`);
      cids.push(cid);
      tracker.add("doc1", cid, now - 6 * DAY + i * HOUR);
    }

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);
    expect(removed).toHaveLength(0);
    expect(tracker.getHistory("doc1")).toHaveLength(10);
  });

  it("thins hourly tier to 1 per hour bucket", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Add tip (recent)
    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Add 3 snapshots in the same hour, 10 days ago
    // (within hourly tier: 7-14d).
    // Align to hour start to avoid straddling.
    const baseTs = Math.floor((now - 10 * DAY) / HOUR) * HOUR;
    const a = await makeCid("hourly-a");
    const b = await makeCid("hourly-b");
    const c = await makeCid("hourly-c");
    tracker.add("doc1", a, baseTs);
    tracker.add("doc1", b, baseTs + 10 * 60_000);
    tracker.add("doc1", c, baseTs + 20 * 60_000);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    // Should keep only the latest in the hour bucket
    // (c) and remove a and b
    expect(removed).toHaveLength(2);
    const remainingCids = tracker.getHistory("doc1").map((s) => s.cid);
    expect(remainingCids).toContain(c.toString());
    expect(remainingCids).toContain(tip.toString());
    expect(remainingCids).not.toContain(a.toString());
    expect(remainingCids).not.toContain(b.toString());
  });

  it("thins daily tier to 1 per day bucket", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Add tip
    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Add 3 snapshots on the same day, 20 days ago
    // (within daily tier: 14-30d).
    // Align to day start to avoid straddling.
    const baseTs = Math.floor((now - 20 * DAY) / DAY) * DAY;
    const a = await makeCid("daily-a");
    const b = await makeCid("daily-b");
    const c = await makeCid("daily-c");
    tracker.add("doc1", a, baseTs);
    tracker.add("doc1", b, baseTs + 3 * HOUR);
    tracker.add("doc1", c, baseTs + 6 * HOUR);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    // Should keep only the latest in the day bucket
    // (c) and remove a and b
    expect(removed).toHaveLength(2);
    const remainingCids = tracker.getHistory("doc1").map((s) => s.cid);
    expect(remainingCids).toContain(c.toString());
    expect(remainingCids).not.toContain(a.toString());
    expect(remainingCids).not.toContain(b.toString());
  });

  it("prunes snapshots beyond daily tier entirely", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Add tip
    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Add snapshot 35 days ago (beyond 30d daily tier)
    const ancient = await makeCid("ancient");
    tracker.add("doc1", ancient, now - 35 * DAY);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    expect(removed).toHaveLength(1);
    expect(removed[0]!.toString()).toBe(ancient.toString());
    const remainingCids = tracker.getHistory("doc1").map((s) => s.cid);
    expect(remainingCids).not.toContain(ancient.toString());
  });

  it("never removes the tip regardless of age", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Only snapshot is 60 days old (way past all tiers)
    const old = await makeCid("ancient-tip");
    tracker.add("doc1", old, now - 60 * DAY);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    expect(removed).toHaveLength(0);
    expect(tracker.getTip("doc1")).toBe(old.toString());
  });

  it("is idempotent — running twice gives same result", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Add snapshots across tiers
    for (let i = 0; i < 5; i++) {
      const cid = await makeCid(`hourly-${i}`);
      tracker.add("doc1", cid, now - 10 * DAY + i * 10 * 60_000);
    }

    const removed1 = tracker.thinSnapshots("doc1", defaultConfig, now);
    const countAfterFirst = tracker.getHistory("doc1").length;

    const removed2 = tracker.thinSnapshots("doc1", defaultConfig, now);

    expect(removed2).toHaveLength(0);
    expect(tracker.getHistory("doc1")).toHaveLength(countAfterFirst);
  });

  it("returns empty for unknown ipnsName", () => {
    const tracker = createHistoryTracker();
    const removed = tracker.thinSnapshots("unknown", defaultConfig);
    expect(removed).toHaveLength(0);
  });

  it("handles multiple hour buckets in hourly tier", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Two snapshots in hour-bucket X, two in
    // hour-bucket X+1, at 10 days ago.
    // Align to hour boundary so +30min stays in
    // the same bucket regardless of wall clock.
    const baseTs = Math.floor((now - 10 * DAY) / HOUR) * HOUR;
    const h0a = await makeCid("h0a");
    const h0b = await makeCid("h0b");
    const h1a = await makeCid("h1a");
    const h1b = await makeCid("h1b");

    tracker.add("doc1", h0a, baseTs);
    tracker.add("doc1", h0b, baseTs + 30 * 60_000);
    tracker.add("doc1", h1a, baseTs + HOUR);
    tracker.add("doc1", h1b, baseTs + HOUR + 30 * 60_000);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    // Should keep h0b and h1b (latest in each bucket)
    // Remove h0a and h1a
    expect(removed).toHaveLength(2);
    const remainingCids = tracker.getHistory("doc1").map((s) => s.cid);
    expect(remainingCids).toContain(h0b.toString());
    expect(remainingCids).toContain(h1b.toString());
    expect(remainingCids).not.toContain(h0a.toString());
    expect(remainingCids).not.toContain(h1a.toString());
  });

  it("respects custom retention config", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Snapshot 3 days ago — would be in "full" tier
    // with default config (7d), but with custom
    // config of 2d it's in "hourly" tier.
    // Align to hour start to avoid straddling.
    const hourlyBase = Math.floor((now - 3 * DAY) / HOUR) * HOUR;
    const a = await makeCid("short-a");
    const b = await makeCid("short-b");
    tracker.add("doc1", a, hourlyBase);
    tracker.add("doc1", b, hourlyBase + 10 * 60_000);

    const shortConfig: RetentionConfig = {
      fullResolutionMs: 2 * DAY,
      hourlyRetentionMs: 5 * DAY,
      dailyRetentionMs: 10 * DAY,
    };

    const removed = tracker.thinSnapshots("doc1", shortConfig, now);

    // a and b are in same hour bucket, 3 days old,
    // in hourly tier (2-5d). Keep latest (b), remove a
    expect(removed).toHaveLength(1);
    expect(removed[0]!.toString()).toBe(a.toString());
  });

  it("spans all tiers in a single call", async () => {
    const tracker = createHistoryTracker();
    const now = Date.now();

    // Tip (current)
    const tip = await makeCid("tip");
    tracker.add("doc1", tip, now - 1000);

    // Full tier (3 days ago) — kept
    const full = await makeCid("full");
    tracker.add("doc1", full, now - 3 * DAY);

    // Hourly tier (10 days ago) — 2 in same hour,
    // keep latest. Align to hour start.
    const hourBase = Math.floor((now - 10 * DAY) / HOUR) * HOUR;
    const hourA = await makeCid("hour-a");
    const hourB = await makeCid("hour-b");
    tracker.add("doc1", hourA, hourBase);
    tracker.add("doc1", hourB, hourBase + 15 * 60_000);

    // Daily tier (20 days ago) — 2 in same day,
    // keep latest. Align to day start.
    const dayBase = Math.floor((now - 20 * DAY) / DAY) * DAY;
    const dayA = await makeCid("day-a");
    const dayB = await makeCid("day-b");
    tracker.add("doc1", dayA, dayBase);
    tracker.add("doc1", dayB, dayBase + 3 * HOUR);

    // Beyond daily (35 days ago) — pruned entirely
    const ancient = await makeCid("ancient");
    tracker.add("doc1", ancient, now - 35 * DAY);

    const removed = tracker.thinSnapshots("doc1", defaultConfig, now);

    // Removed: hourA, dayA, ancient = 3
    expect(removed).toHaveLength(3);

    const remainingCids = tracker.getHistory("doc1").map((s) => s.cid);
    // Kept: tip, full, hourB, dayB = 4
    expect(remainingCids).toHaveLength(4);
    expect(remainingCids).toContain(tip.toString());
    expect(remainingCids).toContain(full.toString());
    expect(remainingCids).toContain(hourB.toString());
    expect(remainingCids).toContain(dayB.toString());
  });
});
