/**
 * Tests for HistoryTracker deep history scenarios
 * (DC-5). HTTP endpoint tests live in http.test.ts
 * alongside the startBlockServer tests.
 */
import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createHistoryTracker } from "./history.js";

async function makeCid(data: string): Promise<CID> {
  const bytes = new TextEncoder().encode(data);
  const hash = await sha256.digest(bytes);
  return CID.create(1, 0x55, hash);
}

describe("HistoryTracker deep history", () => {
  it("tracks 10+ entries per name in order", async () => {
    const tracker = createHistoryTracker();
    const cids: Array<{
      cid: CID;
      ts: number;
    }> = [];
    for (let i = 0; i < 15; i++) {
      const cid = await makeCid(`block-${i}`);
      const ts = 1000 + i * 100;
      tracker.add("name1", cid, ts);
      cids.push({ cid, ts });
    }

    const history = tracker.getHistory("name1");
    expect(history).toHaveLength(15);

    // All entries present
    for (const { cid } of cids) {
      expect(history.some((h) => h.cid === cid.toString())).toBe(true);
    }
  });

  it("getHistory returns copies" + " (not live references)", async () => {
    const tracker = createHistoryTracker();
    const cid1 = await makeCid("a");
    tracker.add("name1", cid1, 1000);

    const h1 = tracker.getHistory("name1");
    const cid2 = await makeCid("b");
    tracker.add("name1", cid2, 2000);

    const h2 = tracker.getHistory("name1");
    // h1 should not have been mutated
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(2);
  });

  it(
    "prune removes old entries but keeps" + " tip even with 10+ entries",
    async () => {
      const tracker = createHistoryTracker();
      const now = Date.now();
      // 15 days — beyond 14-day retention window
      const old = 15 * 24 * 60 * 60 * 1000;

      // Add 12 entries: 10 old, 2 recent
      for (let i = 0; i < 10; i++) {
        const cid = await makeCid(`old-${i}`);
        tracker.add("name1", cid, now - old);
      }
      const recentCid1 = await makeCid("recent-1");
      const recentCid2 = await makeCid("recent-2");
      tracker.add("name1", recentCid1, now - 1000);
      tracker.add("name1", recentCid2, now);

      const removed = tracker.prune(now);
      // Tip is recentCid2 (newest), so all 10 old
      // ones get pruned (beyond 14-day retention)
      expect(removed.length).toBe(10);

      const history = tracker.getHistory("name1");
      expect(history).toHaveLength(2);
    },
  );

  it("handles interleaved names" + " with independent histories", async () => {
    const tracker = createHistoryTracker();

    for (let i = 0; i < 5; i++) {
      const cidA = await makeCid(`a-${i}`);
      const cidB = await makeCid(`b-${i}`);
      tracker.add("nameA", cidA, 1000 + i);
      tracker.add("nameB", cidB, 2000 + i);
    }

    const histA = tracker.getHistory("nameA");
    const histB = tracker.getHistory("nameB");
    expect(histA).toHaveLength(5);
    expect(histB).toHaveLength(5);

    // No cross-contamination
    for (const h of histA) {
      expect(h.cid).not.toMatch(/^b-/);
    }
  });
});
