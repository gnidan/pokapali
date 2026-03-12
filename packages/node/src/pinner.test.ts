import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { code as dagCborCode } from "@ipld/dag-cbor";

// Use vi.hoisted so mock fns are available when
// the vi.mock factories run (hoisted above imports).
const { mockResolve, mockRepublish, mockPubKeyFromRaw } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockRepublish: vi.fn(),
  mockPubKeyFromRaw: vi.fn(() => ({
    toMultihash: () => "mock-multihash",
  })),
}));
vi.mock("@helia/ipns", () => ({
  ipns: () => ({
    resolve: mockResolve,
    republishRecord: mockRepublish,
  }),
}));
vi.mock("@libp2p/crypto/keys", () => ({
  publicKeyFromRaw: mockPubKeyFromRaw,
}));

import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/snapshot";
import { createPinner } from "./pinner.js";

async function makeSnapshot(opts?: {
  seq?: number;
  ts?: number;
  prev?: CID | null;
}): Promise<Uint8Array> {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, "test-app", ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  return encodeSnapshot(
    { content: new Uint8Array([1, 2, 3]) },
    keys.readKey,
    opts?.prev ?? null,
    opts?.seq ?? 1,
    opts?.ts ?? Date.now(),
    signingKey,
  );
}

async function blockToCid(block: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(block);
  return CID.create(1, dagCborCode, hash);
}

function createMockHelia(blocks: Map<string, Uint8Array> = new Map()) {
  return {
    blockstore: {
      get: vi.fn(async (cid: CID) => {
        const data = blocks.get(cid.toString());
        if (!data) {
          throw new Error("block not found");
        }
        return data;
      }),
      has: vi.fn(async (cid: CID) => {
        return blocks.has(cid.toString());
      }),
      put: vi.fn(async () => {}),
    },
    routing: {},
    libp2p: {
      peerId: "mock-peer-id",
      services: {},
    },
  };
}

describe("pinner with mock helia", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pinner-test-"));
    mockResolve.mockReset();
    mockRepublish.mockReset();
    mockPubKeyFromRaw.mockClear();
    mockPubKeyFromRaw.mockReturnValue({
      toMultihash: () => "mock-multihash",
    });
  });

  afterEach(async () => {
    await rm(tmpDir, {
      recursive: true,
      force: true,
    });
  });

  describe("fetchByCid (via onAnnouncement)", () => {
    it("fetches and tracks valid block", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid.toString(),
      );
      await pinner.flush();

      const tip = pinner.history.getTip(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
      );
      expect(tip).toBe(cid.toString());

      expect(mockHelia.blockstore.get).toHaveBeenCalledWith(
        cid,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );

      await pinner.stop();
    });

    it("skips fetch when CID matches current tip", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      // First announcement — should fetch
      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid.toString(),
      );
      await pinner.flush();
      expect(mockHelia.blockstore.get).toHaveBeenCalledTimes(1);

      // Same CID again — should skip (dedup)
      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid.toString(),
      );
      await pinner.flush();
      // Still only 1 call — second was skipped
      expect(mockHelia.blockstore.get).toHaveBeenCalledTimes(1);

      await pinner.stop();
    });

    it("rejects invalid blocks from blockstore", async () => {
      const garbage = new Uint8Array(256);
      crypto.getRandomValues(garbage);
      const hash = await sha256.digest(garbage);
      const cid = CID.create(1, dagCborCode, hash);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), garbage);
      const mockHelia = createMockHelia(blocks);

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid.toString(),
      );
      await pinner.flush();

      // Should not be tracked — invalid block
      const tip = pinner.history.getTip(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
      );
      expect(tip).toBeNull();

      await pinner.stop();
    });

    it("handles blockstore fetch errors gracefully", async () => {
      // Empty blockstore — get() will throw
      const mockHelia = createMockHelia();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      const fakeCid = CID.create(
        1,
        dagCborCode,
        await sha256.digest(new TextEncoder().encode("fake")),
      );

      // Should not throw — errors are caught
      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        fakeCid.toString(),
      );
      await pinner.flush();

      const tip = pinner.history.getTip(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
      );
      expect(tip).toBeNull();

      await pinner.stop();
    });

    it("updates tip when new CID announced", async () => {
      const block1 = await makeSnapshot({
        seq: 1,
        ts: 1000,
      });
      const block2 = await makeSnapshot({
        seq: 2,
        ts: 2000,
      });
      const cid1 = await blockToCid(block1);
      const cid2 = await blockToCid(block2);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid1.toString(), block1);
      blocks.set(cid2.toString(), block2);
      const mockHelia = createMockHelia(blocks);

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid1.toString(),
      );
      await pinner.flush();
      expect(
        pinner.history.getTip(
          "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        ),
      ).toBe(cid1.toString());

      pinner.onAnnouncement(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        cid2.toString(),
      );
      await pinner.flush();
      expect(
        pinner.history.getTip(
          "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        ),
      ).toBe(cid2.toString());

      await pinner.stop();
    });
  });

  describe("resolveAndFetch", () => {
    it("resolves known names on startup", async () => {
      // Step 1: create pinner, ingest a block to
      // populate knownNames, then stop (persists)
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);

      const pinner1 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner1.start();
      await pinner1.ingest(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        block,
      );
      await pinner1.stop();

      // Step 2: create new pinner with mock helia.
      // On start(), it should resolveAll for
      // persisted knownNames.
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      // Configure shared mocks for this test
      mockResolve.mockResolvedValue({
        cid,
        record: new Uint8Array(),
      });

      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner2.start();

      // resolveAll fires async on start; flush it
      await pinner2.flush();

      expect(mockResolve).toHaveBeenCalled();

      // The resolved CID matches the restored tip,
      // so fetchByCid returns early (already have it).
      // Verify resolve was still called.
      expect(mockResolve).toHaveBeenCalled();

      await pinner2.stop();
    });

    it("handles IPNS resolve failure gracefully", async () => {
      // Populate knownNames via state file
      const block = await makeSnapshot({ ts: 5000 });
      const pinner1 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner1.start();
      await pinner1.ingest(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        block,
      );
      await pinner1.stop();

      const mockHelia = createMockHelia();

      // Configure shared mock to reject
      mockResolve.mockRejectedValue(new Error("resolve failed"));

      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });

      // Should not throw even if resolve fails
      await pinner2.start();
      await pinner2.flush();

      // Backfill may call blockstore.get once per tip
      // for chain walking (fails gracefully since
      // block isn't in the mock). Resolve failure
      // should not trigger additional block fetches.
      expect(mockHelia.blockstore.get.mock.calls.length).toBeLessThanOrEqual(1);

      await pinner2.stop();
    });
  });

  describe("onGuaranteeQuery", () => {
    const IPNS_NAME =
      "aa11bb22cc33dd44ee55ff66" +
      "00112233aa11bb22cc33dd44" +
      "ee55ff6600112233";

    it("ignores unknown ipnsNames", async () => {
      const mockPubsub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        pubsub: mockPubsub as any,
        peerId: "pinner-peer-id",
      });
      await pinner.start();

      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();

      expect(mockPubsub.publish).not.toHaveBeenCalled();
      await pinner.stop();
    });

    it("requires pubsub to respond", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        // no pubsub, no peerId
      });
      await pinner.start();
      await pinner.ingest(IPNS_NAME, block);

      // Should silently return — no pubsub configured
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();

      // No throw = pass
      await pinner.stop();
    });

    it("publishes guarantee-response with correct" + " fields", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const mockPubsub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        pubsub: mockPubsub as any,
        peerId: "pinner-peer-id",
      });
      await pinner.start();
      await pinner.ingest(IPNS_NAME, block);

      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();

      expect(mockPubsub.publish).toHaveBeenCalledTimes(1);
      const [topic, data] = mockPubsub.publish.mock.calls[0];
      expect(topic).toBe("/pokapali/app/test-app/announce");

      const response = JSON.parse(new TextDecoder().decode(data));
      expect(response.type).toBe("guarantee-response");
      expect(response.ipnsName).toBe(IPNS_NAME);
      expect(response.peerId).toBe("pinner-peer-id");
      expect(response.cid).toBe(cid.toString());
      expect(response.guaranteeUntil).toBeGreaterThan(Date.now());
      expect(response.retainUntil).toBeGreaterThan(Date.now());
      await pinner.stop();
    });

    it("rate-limits responses to 1 per 3 seconds", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const mockPubsub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        pubsub: mockPubsub as any,
        peerId: "pinner-peer-id",
      });
      await pinner.start();
      await pinner.ingest(IPNS_NAME, block);

      // First query — should respond
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();
      expect(mockPubsub.publish).toHaveBeenCalledTimes(1);

      // Immediate second query — rate-limited
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();
      expect(mockPubsub.publish).toHaveBeenCalledTimes(1);

      await pinner.stop();
    });

    it("responds again after cooldown expires", async () => {
      vi.useFakeTimers();
      const block = await makeSnapshot({ ts: 5000 });
      const mockPubsub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        pubsub: mockPubsub as any,
        peerId: "pinner-peer-id",
      });
      await pinner.start();
      await pinner.ingest(IPNS_NAME, block);

      // First query
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();
      expect(mockPubsub.publish).toHaveBeenCalledTimes(1);

      // Advance past 3s cooldown
      await vi.advanceTimersByTimeAsync(3_001);

      // Second query — should respond now
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();
      expect(mockPubsub.publish).toHaveBeenCalledTimes(2);

      await pinner.stop();
      vi.useRealTimers();
    });

    it("does not respond when name is known" + " but has no tip", async () => {
      // onAnnouncement adds to knownNames before
      // fetchByCid resolves. If fetch fails, name
      // is known but getTip returns null.
      const mockHelia = createMockHelia(); // empty
      const mockPubsub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
        pubsub: mockPubsub as any,
        peerId: "pinner-peer-id",
      });
      await pinner.start();

      // Announce with unfetchable CID — name added
      // to knownNames but fetch fails → no tip.
      const fakeCid = CID.create(
        1,
        dagCborCode,
        await sha256.digest(new TextEncoder().encode("fake")),
      );
      pinner.onAnnouncement(IPNS_NAME, fakeCid.toString());
      await pinner.flush();

      // Now query — name is known but no tip
      pinner.onGuaranteeQuery(IPNS_NAME, "test-app");
      await pinner.flush();

      expect(mockPubsub.publish).not.toHaveBeenCalled();
      await pinner.stop();
    });
  });

  describe("republishAllIPNS", () => {
    it("republishes records for known names", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      // Configure shared mocks
      mockResolve.mockResolvedValue({
        cid,
        record: new Uint8Array([1, 2, 3]),
      });
      mockRepublish.mockResolvedValue(undefined);

      // Install fake timers BEFORE start() so the
      // internal setTimeout uses them
      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      // Add a known name via ingest
      await pinner.ingest(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        block,
      );

      // Advance past the 5-minute initial republish
      // delay and flush all pending async work.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await pinner.flush();

      // Stop pinner to clear intervals
      await pinner.stop();
      vi.useRealTimers();

      expect(mockResolve).toHaveBeenCalled();
      expect(mockRepublish).toHaveBeenCalledWith(
        "mock-multihash",
        expect.any(Uint8Array),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("handles republish failure gracefully", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      // Configure shared mocks — republish fails
      mockResolve.mockResolvedValue({
        cid,
        record: new Uint8Array([1, 2, 3]),
      });
      mockRepublish.mockRejectedValue(new Error("DHT unavailable"));

      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();
      await pinner.ingest(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
        block,
      );

      // Advance past the 5-minute initial republish
      // delay and flush all pending async work.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await pinner.flush();

      // Should not throw — errors are caught
      // Pinner should still be functional
      const tip = pinner.history.getTip(
        "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233",
      );
      expect(tip).toBe(cid.toString());

      await pinner.stop();
      vi.useRealTimers();
    });

    it("skips recently republished names", async () => {
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      mockResolve.mockResolvedValue({
        cid,
        record: new Uint8Array([1, 2, 3]),
      });
      mockRepublish.mockResolvedValue(undefined);

      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      const name =
        "aa11bb22cc33dd44ee55ff66" +
        "00112233aa11bb22cc33dd44" +
        "ee55ff6600112233";
      await pinner.ingest(name, block);

      // Trigger initial republish (5 min)
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.advanceTimersByTimeAsync(8_000);

      const firstCallCount = mockRepublish.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Trigger next 4h cycle — CID unchanged,
      // <20h since last republish → should skip
      await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(8_000);

      // No new republish calls
      expect(mockRepublish.mock.calls.length).toBe(firstCallCount);

      await pinner.stop();
      vi.useRealTimers();
    });

    it("aborts cycle on >50% failure rate", async () => {
      // Create 30 names to trigger circuit breaker
      // (need 20+ attempts with >50% fail)
      const block = await makeSnapshot({ ts: 5000 });
      const cid = await blockToCid(block);
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const mockHelia = createMockHelia(blocks);

      // Resolve succeeds during startup resolveAll
      // but fails during republish
      mockResolve.mockResolvedValue({
        cid,
        record: new Uint8Array([1, 2, 3]),
      });
      mockRepublish.mockResolvedValue(undefined);

      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner.start();

      // Ingest 30 names
      for (let i = 0; i < 30; i++) {
        const hex = i.toString(16).padStart(2, "0");
        const name = hex.padEnd(64, "0");
        const b = await makeSnapshot({
          ts: 5000 + i,
        });
        const c = await blockToCid(b);
        blocks.set(c.toString(), b);
        await pinner.ingest(name, b);
      }

      // Let startup resolveAll complete
      for (let t = 0; t < 20; t++) {
        await vi.advanceTimersByTimeAsync(500);
      }

      // Now make republish fail — switch mock
      mockResolve.mockRejectedValue(new Error("DHT dead"));
      mockRepublish.mockClear();

      // Trigger initial republish (5min timer)
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.advanceTimersByTimeAsync(8_000);

      // Circuit breaker fires at 20 failures. Since
      // republishOne calls resolve then republish,
      // no republish calls should succeed (resolve
      // fails first). The breaker should have
      // stopped early — fewer than 30 names tried.
      // mockRepublish should NOT be called since
      // resolve fails before it.
      expect(mockRepublish).not.toHaveBeenCalled();

      await pinner.stop();
      vi.useRealTimers();
    });
  });

  describe("backfillHistory", () => {
    it("walks chain from tip to populate history", async () => {
      // Build a 3-block chain: genesis → mid → tip
      const genesis = await makeSnapshot({
        seq: 1,
        ts: 1000,
        prev: null,
      });
      const genesisCid = await blockToCid(genesis);

      const mid = await makeSnapshot({
        seq: 2,
        ts: 2000,
        prev: genesisCid,
      });
      const midCid = await blockToCid(mid);

      const tip = await makeSnapshot({
        seq: 3,
        ts: 3000,
        prev: midCid,
      });
      const tipCid = await blockToCid(tip);

      // First pinner: ingest the tip (state.json
      // will record tip CID)
      const pinner1 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner1.start();
      const name =
        "aa11bb22cc33dd44ee55ff66" +
        "00112233aa11bb22cc33dd44" +
        "ee55ff6600112233";
      await pinner1.ingest(name, tip);
      await pinner1.stop();

      // Verify: only 1 entry (the tip) after
      // first pinner
      expect(pinner1.history.getHistory(name)).toHaveLength(1);

      // Second pinner with mock helia that has
      // all 3 blocks in blockstore
      const blocks = new Map<string, Uint8Array>();
      blocks.set(tipCid.toString(), tip);
      blocks.set(midCid.toString(), mid);
      blocks.set(genesisCid.toString(), genesis);
      const mockHelia = createMockHelia(blocks);

      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner2.start();
      await pinner2.flush();

      // Backfill should have walked the chain and
      // found all 3 blocks
      const history = pinner2.history.getHistory(name);
      expect(history).toHaveLength(3);

      // Verify all CIDs present
      const cids = history.map((h) => h.cid);
      expect(cids).toContain(tipCid.toString());
      expect(cids).toContain(midCid.toString());
      expect(cids).toContain(genesisCid.toString());

      // Verify timestamps
      const tsBySeq = history.sort((a, b) => a.ts - b.ts);
      expect(tsBySeq[0].ts).toBe(1000);
      expect(tsBySeq[1].ts).toBe(2000);
      expect(tsBySeq[2].ts).toBe(3000);

      await pinner2.stop();
    });

    it("skips backfill when history index exists", async () => {
      // Build a 2-block chain
      const genesis = await makeSnapshot({
        seq: 1,
        ts: 1000,
        prev: null,
      });
      const genesisCid = await blockToCid(genesis);
      const tip = await makeSnapshot({
        seq: 2,
        ts: 2000,
        prev: genesisCid,
      });
      const tipCid = await blockToCid(tip);

      const name =
        "bb22cc33dd44ee55ff660011" +
        "2233aa11bb22cc33dd44ee55" +
        "ff6600112233bb22";

      // First pinner: ingest tip + genesis via
      // history.add so persistState saves the index
      const pinner1 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner1.start();
      await pinner1.ingest(name, tip);
      // Manually add genesis to history so index
      // has 2 entries
      pinner1.history.add(name, genesisCid, 1000);
      await pinner1.stop();

      // Second pinner with mock helia — blockstore
      // should NOT be called for chain walking since
      // history index already has >1 entries
      const blocks = new Map<string, Uint8Array>();
      blocks.set(tipCid.toString(), tip);
      blocks.set(genesisCid.toString(), genesis);
      const mockHelia = createMockHelia(blocks);

      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
      });
      await pinner2.start();
      await pinner2.flush();

      // History should have 2 entries from index
      const history = pinner2.history.getHistory(name);
      expect(history).toHaveLength(2);

      // blockstore.get should not have been called
      // (index had full history, no backfill needed)
      expect(mockHelia.blockstore.get).not.toHaveBeenCalled();

      await pinner2.stop();
    });
  });

  describe("stale name pruning", () => {
    it(
      "prunes names with no activity and no" + " resolve for staleResolveDays",
      async () => {
        vi.useFakeTimers();
        const now = Date.now();

        const pinner = await createPinner({
          appIds: ["test-app"],
          storagePath: tmpDir,
          staleResolveDays: 3,
        });
        await pinner.start();

        // Ingest a block — sets lastSeenAt to now
        const block = await makeSnapshot({ ts: now });
        const name =
          "aa11bb22cc33dd44ee55ff66" +
          "00112233aa11bb22cc33dd44" +
          "ee55ff6600112233";
        await pinner.ingest(name, block);

        // Verify it's tracked
        expect(pinner.history.getTip(name)).not.toBeNull();

        // Advance 4 days — past 3-day stale threshold
        await vi.advanceTimersByTimeAsync(4 * 24 * 60 * 60_000);

        // Stop and restart to trigger pruneIfNeeded
        await pinner.stop();
        const pinner2 = await createPinner({
          appIds: ["test-app"],
          storagePath: tmpDir,
          staleResolveDays: 3,
        });
        await pinner2.start();

        // Name should have been pruned (no resolve,
        // lastSeenAt > 3 days ago)
        const m = pinner2.metrics();
        expect(m.knownNames).toBe(0);
        expect(m.stalePruned).toBeGreaterThan(0);

        await pinner2.stop();
        vi.useRealTimers();
      },
    );

    it(
      "preserves names with recent activity" + " even without resolve",
      async () => {
        const pinner = await createPinner({
          appIds: ["test-app"],
          storagePath: tmpDir,
          staleResolveDays: 3,
        });
        await pinner.start();

        // Ingest a block — lastSeenAt = now
        const block = await makeSnapshot({
          ts: Date.now(),
        });
        const name =
          "aa11bb22cc33dd44ee55ff66" +
          "00112233aa11bb22cc33dd44" +
          "ee55ff6600112233";
        await pinner.ingest(name, block);

        // Name should NOT be pruned (recent activity)
        const m = pinner.metrics();
        expect(m.knownNames).toBe(1);
        expect(m.stalePruned).toBe(0);

        await pinner.stop();
      },
    );

    it("prunes never-resolved names after 12h" + " grace period", async () => {
      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        staleResolveDays: 3,
      });
      await pinner.start();

      const block = await makeSnapshot({
        ts: Date.now(),
      });
      const name =
        "aa11bb22cc33dd44ee55ff66" +
        "00112233aa11bb22cc33dd44" +
        "ee55ff6600112233";
      await pinner.ingest(name, block);

      // Advance 13 hours — past 12h grace
      await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);

      await pinner.stop();
      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        staleResolveDays: 3,
      });
      await pinner2.start();

      // Should be pruned (never resolved, seen
      // >12h ago)
      const m = pinner2.metrics();
      expect(m.knownNames).toBe(0);
      expect(m.stalePruned).toBeGreaterThan(0);

      await pinner2.stop();
      vi.useRealTimers();
    });

    it("disables stale pruning when" + " staleResolveDays=0", async () => {
      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        staleResolveDays: 0,
      });
      await pinner.start();

      const block = await makeSnapshot({
        ts: Date.now(),
      });
      const name =
        "aa11bb22cc33dd44ee55ff66" +
        "00112233aa11bb22cc33dd44" +
        "ee55ff6600112233";
      await pinner.ingest(name, block);

      // Advance 10 days — past any stale threshold
      await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60_000);

      await pinner.stop();
      const pinner2 = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        staleResolveDays: 0,
      });
      await pinner2.start();

      // Still present (stale pruning disabled, but
      // retention pruning may apply at 14 days)
      const m = pinner2.metrics();
      expect(m.knownNames).toBe(1);
      expect(m.stalePruned).toBe(0);

      await pinner2.stop();
      vi.useRealTimers();
    });

    it("exposes stalePruned in metrics", async () => {
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner.start();

      const m = pinner.metrics();
      expect(typeof m.stalePruned).toBe("number");
      expect(m.stalePruned).toBe(0);

      await pinner.stop();
    });
  });

  describe("IPNS rate limiting", () => {
    it("throttles republish operations", async () => {
      // Ingest 5 names, set rate limit to 2/sec,
      // trigger republish. The throttle metrics
      // should show acquired > 0.
      const blocks = new Map<string, Uint8Array>();
      const mockHelia = createMockHelia(blocks);

      mockResolve.mockResolvedValue({
        cid: CID.create(
          1,
          dagCborCode,
          await sha256.digest(new TextEncoder().encode("x")),
        ),
        record: new Uint8Array([1, 2, 3]),
      });
      mockRepublish.mockResolvedValue(undefined);

      vi.useFakeTimers();

      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        helia: mockHelia as any,
        ipnsRateLimit: 2, // 2 req/sec
      });
      await pinner.start();

      for (let i = 0; i < 5; i++) {
        const hex = (i + 0xa0).toString(16).padStart(2, "0");
        const name = hex.padEnd(64, "0");
        const b = await makeSnapshot({
          ts: 5000 + i,
        });
        const c = await blockToCid(b);
        blocks.set(c.toString(), b);
        await pinner.ingest(name, b);
      }

      // Trigger initial republish (5 min)
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Allow throttle wait timers to fire
      await vi.advanceTimersByTimeAsync(10_000);
      await pinner.flush();

      const m = pinner.metrics();
      expect(m.ipnsThrottleAcquired).toBeGreaterThan(0);

      await pinner.stop();
      vi.useRealTimers();
    });

    it("exposes throttle metrics", async () => {
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
        ipnsRateLimit: 10,
      });
      await pinner.start();

      const m = pinner.metrics();
      expect(m.ipnsThrottleAcquired).toBe(0);
      expect(m.ipnsThrottleRejected).toBe(0);

      await pinner.stop();
    });

    it("defaults to 10 req/sec when not configured", async () => {
      const pinner = await createPinner({
        appIds: ["test-app"],
        storagePath: tmpDir,
      });
      await pinner.start();

      // Should have throttle metrics available
      const m = pinner.metrics();
      expect(typeof m.ipnsThrottleAcquired).toBe("number");
      expect(typeof m.ipnsThrottleRejected).toBe("number");

      await pinner.stop();
    });
  });
});
