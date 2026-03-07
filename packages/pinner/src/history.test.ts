import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createHistoryTracker } from "./history.js";

async function makeCid(
  data: string
): Promise<CID> {
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

  it("prunes snapshots older than 24h", async () => {
    const tracker = createHistoryTracker();
    const old = await makeCid("old");
    const recent = await makeCid("recent");

    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    tracker.add("name1", old, dayAgo);
    tracker.add("name1", recent, now - 1000);

    const removed = tracker.prune(now);
    expect(removed).toHaveLength(1);
    expect(removed[0].toString()).toBe(
      old.toString()
    );

    const entry = tracker.getEntry("name1");
    expect(entry!.snapshots).toHaveLength(1);
    expect(entry!.snapshots[0].cid).toBe(
      recent.toString()
    );
  });

  it("always keeps the tip even if old", async () => {
    const tracker = createHistoryTracker();
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
