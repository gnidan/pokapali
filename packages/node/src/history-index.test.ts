/**
 * Tests for GET /history/:ipnsName endpoint (DC-3)
 * and deep history scenarios (DC-5).
 *
 * The endpoint is being built by ops in Track E.
 * These tests define expected behavior and will
 * fail with 404 until the endpoint is implemented.
 */
import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import type { Server } from "node:http";
import { startHttpServer } from "./http.js";
import type { HttpConfig } from "./http.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createHistoryTracker, type HistoryTracker } from "./history.js";

// Helper to make HTTP requests
function fetch(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function makeCid(data: string): Promise<CID> {
  const bytes = new TextEncoder().encode(data);
  const hash = await sha256.digest(bytes);
  return CID.create(1, 0x55, hash);
}

// Mock relay (minimal)
function mockRelay() {
  return {
    peerId: () => "12D3KooWTestPeer",
    multiaddrs: () => [],
    helia: {
      libp2p: {
        getConnections: () => [],
        getPeers: () => [],
        getMultiaddrs: () => [],
        services: {
          pubsub: {
            getTopics: () => [],
            getPeers: () => [],
            getSubscribers: () => [],
            mesh: new Map(),
          },
        },
      },
    },
  } as any;
}

// Mock pinner with history tracker
function mockPinnerWithHistory(history: HistoryTracker) {
  return {
    ingest: async () => true,
    metrics: () => ({
      knownNames: 10,
      tipsTracked: 10,
      acksTracked: 5,
    }),
    history,
  } as any;
}

// Skipped: endpoint not yet on main. Unskip after
// ops Track E (68c222f) is merged.
describe.skip("GET /history/:ipnsName", () => {
  let server: Server;
  let port: number;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  function start(config: Partial<HttpConfig> = {}) {
    const cfg: HttpConfig = {
      port: 0,
      relay: config.relay ?? null,
      pinner: config.pinner ?? null,
      pinAppIds: config.pinAppIds ?? [],
      ...config,
    };
    server = startHttpServer(cfg);
    const addr = server.address() as any;
    port = addr.port;
  }

  it("returns history entries for known name", async () => {
    const history = createHistoryTracker();
    const cid1 = await makeCid("snap-1");
    const cid2 = await makeCid("snap-2");
    history.add("aaaa1111", cid1, 1000);
    history.add("aaaa1111", cid2, 2000);

    start({
      relay: mockRelay(),
      pinner: mockPinnerWithHistory(history),
    });

    const res = await fetch(port, "GET", "/history/aaaa1111");
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].cid).toBe(cid2.toString());
    expect(data.entries[0].ts).toBe(2000);
    expect(data.entries[1].cid).toBe(cid1.toString());
  });

  it("returns empty array for unknown name", async () => {
    const history = createHistoryTracker();
    start({
      relay: mockRelay(),
      pinner: mockPinnerWithHistory(history),
    });

    const res = await fetch(port, "GET", "/history/unknown-name");
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.entries).toEqual([]);
  });

  it("supports limit query parameter", async () => {
    const history = createHistoryTracker();
    for (let i = 0; i < 10; i++) {
      const cid = await makeCid(`snap-${i}`);
      history.add("aaaa1111", cid, 1000 + i);
    }

    start({
      relay: mockRelay(),
      pinner: mockPinnerWithHistory(history),
    });

    const res = await fetch(port, "GET", "/history/aaaa1111?limit=3");
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.entries).toHaveLength(3);
  });

  it("supports before query parameter" + " for pagination", async () => {
    const history = createHistoryTracker();
    const cids: CID[] = [];
    for (let i = 1; i <= 5; i++) {
      const cid = await makeCid(`snap-${i}`);
      history.add("aaaa1111", cid, i * 1000);
      cids.push(cid);
    }

    start({
      relay: mockRelay(),
      pinner: mockPinnerWithHistory(history),
    });

    // Get entries before seq 4 (ts=4000)
    const res = await fetch(port, "GET", "/history/aaaa1111?before=4000");
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    // Should only include entries with ts < 4000
    for (const entry of data.entries) {
      expect(entry.ts).toBeLessThan(4000);
    }
  });

  it("returns 404 when no pinner configured", async () => {
    start({ relay: mockRelay() });
    const res = await fetch(port, "GET", "/history/some-name");
    expect(res.status).toBe(404);
  });
});

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
      const day = 25 * 60 * 60 * 1000;

      // Add 12 entries: 10 old, 2 recent
      for (let i = 0; i < 10; i++) {
        const cid = await makeCid(`old-${i}`);
        tracker.add("name1", cid, now - day);
      }
      const recentCid1 = await makeCid("recent-1");
      const recentCid2 = await makeCid("recent-2");
      tracker.add("name1", recentCid1, now - 1000);
      tracker.add("name1", recentCid2, now);

      const removed = tracker.prune(now);
      // 10 old ones minus the tip should be removed
      // Tip is recentCid2 (newest), so all 10 old
      // ones get pruned
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
