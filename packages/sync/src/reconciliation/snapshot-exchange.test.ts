import { describe, it, expect } from "vitest";
import { MessageType } from "./messages.js";
import {
  createSnapshotExchange,
  selectCidsToRequest,
  type SnapshotCatalogEntry,
  type SnapshotExchangeOptions,
} from "./snapshot-exchange.js";
import type { SnapshotMessage } from "./transport.js";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function cid(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Fixture {
  sent: SnapshotMessage[];
  received: Array<{ cid: Uint8Array; data: Uint8Array }>;
  blocks: Map<string, Uint8Array>;
  catalog: {
    entries: SnapshotCatalogEntry[];
    tip: Uint8Array | null;
  };
  exchange: ReturnType<typeof createSnapshotExchange>;
}

function setupFixture(
  overrides: Partial<SnapshotExchangeOptions> = {},
): Fixture {
  const sent: SnapshotMessage[] = [];
  const received: Array<{ cid: Uint8Array; data: Uint8Array }> = [];
  const blocks = new Map<string, Uint8Array>();
  const catalog: Fixture["catalog"] = { entries: [], tip: null };

  const exchange = createSnapshotExchange({
    send: (msg) => sent.push(msg),
    getLocalCatalog: () => catalog,
    getBlock: (c) => {
      for (const [k, v] of blocks) {
        if (bytesEqual(toBytes(k), c)) return v;
      }
      return null;
    },
    onBlock: (c, d) => received.push({ cid: c, data: d }),
    verify: async () => true,
    ...overrides,
  });

  return { sent, received, blocks, catalog, exchange };
}

function key(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function toBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("snapshot exchange", () => {
  describe("advertise", () => {
    it("sends local catalog", () => {
      const f = setupFixture();
      f.catalog.entries = [
        { cid: cid(1, 2), seq: 1, ts: 100 },
        { cid: cid(3, 4), seq: 2, ts: 200 },
      ];
      f.catalog.tip = cid(3, 4);

      f.exchange.advertise();

      expect(f.sent).toHaveLength(1);
      const msg = f.sent[0]!;
      expect(msg.type).toBe(MessageType.SNAPSHOT_CATALOG);
      if (msg.type !== MessageType.SNAPSHOT_CATALOG) throw new Error();
      expect(msg.entries).toHaveLength(2);
      expect(msg.tip).toEqual(cid(3, 4));
    });

    it("sends empty catalog if no local entries", () => {
      const f = setupFixture();
      f.exchange.advertise();
      expect(f.sent).toHaveLength(1);
      const msg = f.sent[0]!;
      if (msg.type !== MessageType.SNAPSHOT_CATALOG) throw new Error();
      expect(msg.entries).toHaveLength(0);
      expect(msg.tip).toBeNull();
    });

    it("does not send after destroy", () => {
      const f = setupFixture();
      f.exchange.destroy();
      f.exchange.advertise();
      expect(f.sent).toHaveLength(0);
    });
  });

  describe("receive catalog → request", () => {
    it("requests CIDs peer has that we don't", () => {
      const f = setupFixture();
      // We have nothing locally; peer has 2 entries.
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [
          { cid: cid(1), seq: 1, ts: 10 },
          { cid: cid(2), seq: 2, ts: 20 },
        ],
        tip: cid(2),
      });

      expect(f.sent).toHaveLength(1);
      const req = f.sent[0]!;
      if (req.type !== MessageType.SNAPSHOT_REQUEST) throw new Error();
      expect(req.cids).toHaveLength(2);
      // Tip first.
      expect(req.cids[0]).toEqual(cid(2));
      expect(req.cids[1]).toEqual(cid(1));
    });

    it("does not request CIDs we already have", () => {
      const f = setupFixture();
      f.blocks.set(key(cid(1)), new Uint8Array([0xaa]));

      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [
          { cid: cid(1), seq: 1, ts: 10 },
          { cid: cid(2), seq: 2, ts: 20 },
        ],
        tip: cid(2),
      });

      const req = f.sent[0]!;
      if (req.type !== MessageType.SNAPSHOT_REQUEST) throw new Error();
      expect(req.cids).toHaveLength(1);
      expect(req.cids[0]).toEqual(cid(2));
    });

    it("respects request budget", () => {
      const f = setupFixture({ requestBudget: 3 });
      const entries: SnapshotCatalogEntry[] = [];
      for (let i = 1; i <= 5; i++) {
        entries.push({ cid: cid(i), seq: i, ts: i * 10 });
      }
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries,
        tip: null,
      });

      const req = f.sent[0]!;
      if (req.type !== MessageType.SNAPSHOT_REQUEST) throw new Error();
      expect(req.cids).toHaveLength(3);
    });

    it("no-ops when peer has nothing new", () => {
      const f = setupFixture();
      f.blocks.set(key(cid(1)), new Uint8Array([0xaa]));
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [{ cid: cid(1), seq: 1, ts: 10 }],
        tip: cid(1),
      });
      expect(f.sent).toHaveLength(0);
    });

    it("no-ops on empty peer catalog", () => {
      const f = setupFixture();
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [],
        tip: null,
      });
      expect(f.sent).toHaveLength(0);
    });

    it("deduplicates repeat catalogs", () => {
      const f = setupFixture();
      const cat: SnapshotMessage = {
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [{ cid: cid(7), seq: 1, ts: 10 }],
        tip: cid(7),
      };
      f.exchange.receive(cat);
      f.exchange.receive(cat);
      expect(f.sent).toHaveLength(1);
    });

    it("tip priority: requests tip even if not in entries", () => {
      const f = setupFixture();
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [],
        tip: cid(42),
      });
      const req = f.sent[0]!;
      if (req.type !== MessageType.SNAPSHOT_REQUEST) throw new Error();
      expect(req.cids).toHaveLength(1);
      expect(req.cids[0]).toEqual(cid(42));
    });
  });

  describe("receive request → serve", () => {
    it("serves a small block as a single chunk", () => {
      const f = setupFixture({ chunkSize: 1000 });
      const data = new Uint8Array(500).fill(0xab);
      f.blocks.set(key(cid(1)), data);

      f.exchange.receive({
        type: MessageType.SNAPSHOT_REQUEST,
        cids: [cid(1)],
      });

      expect(f.sent).toHaveLength(1);
      const blk = f.sent[0]!;
      if (blk.type !== MessageType.SNAPSHOT_BLOCK) throw new Error();
      expect(blk.cid).toEqual(cid(1));
      expect(blk.block).toEqual(data);
      expect(blk.offset).toBe(0);
      expect(blk.total).toBe(500);
      expect(blk.last).toBe(true);
    });

    it("splits large block into multiple chunks", () => {
      const f = setupFixture({ chunkSize: 100 });
      const data = new Uint8Array(250).fill(0xcd);
      f.blocks.set(key(cid(1)), data);

      f.exchange.receive({
        type: MessageType.SNAPSHOT_REQUEST,
        cids: [cid(1)],
      });

      // 250 bytes split at 100-byte chunks → 3 chunks
      expect(f.sent).toHaveLength(3);
      const chunks = f.sent.filter(
        (
          m,
        ): m is Extract<
          SnapshotMessage,
          { type: typeof MessageType.SNAPSHOT_BLOCK }
        > => m.type === MessageType.SNAPSHOT_BLOCK,
      );
      expect(chunks[0]!.offset).toBe(0);
      expect(chunks[0]!.block.length).toBe(100);
      expect(chunks[0]!.total).toBe(250);
      expect(chunks[0]!.last).toBe(false);
      expect(chunks[1]!.offset).toBe(100);
      expect(chunks[1]!.block.length).toBe(100);
      expect(chunks[1]!.last).toBe(false);
      expect(chunks[2]!.offset).toBe(200);
      expect(chunks[2]!.block.length).toBe(50);
      expect(chunks[2]!.last).toBe(true);
    });

    it("NAKs unknown CIDs", () => {
      const f = setupFixture();
      f.exchange.receive({
        type: MessageType.SNAPSHOT_REQUEST,
        cids: [cid(99)],
      });
      expect(f.sent).toHaveLength(1);
      const nak = f.sent[0]!;
      if (nak.type !== MessageType.SNAPSHOT_BLOCK) throw new Error();
      expect(nak.block).toEqual(new Uint8Array(0));
      expect(nak.total).toBe(0);
      expect(nak.last).toBe(true);
    });

    it("mixes served + NAK across cids, last flag only on final", () => {
      const f = setupFixture({ chunkSize: 100 });
      f.blocks.set(key(cid(1)), new Uint8Array(50).fill(0x01));
      // cid(2) unknown → NAK
      f.blocks.set(key(cid(3)), new Uint8Array(150).fill(0x03));

      f.exchange.receive({
        type: MessageType.SNAPSHOT_REQUEST,
        cids: [cid(1), cid(2), cid(3)],
      });

      // Expected: 1 chunk for cid(1) + NAK for cid(2) +
      // 2 chunks for cid(3) = 4 messages.
      expect(f.sent).toHaveLength(4);
      const lastFlags = f.sent.map((m) => {
        if (m.type !== MessageType.SNAPSHOT_BLOCK) throw new Error();
        return m.last;
      });
      expect(lastFlags).toEqual([false, false, false, true]);
    });
  });

  describe("receive block → reassemble", () => {
    it("single-chunk block is delivered", async () => {
      const f = setupFixture();
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(7),
        block: data,
        offset: 0,
        total: 5,
        last: true,
      });

      // verify() is async; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();

      expect(f.received).toHaveLength(1);
      expect(f.received[0]!.cid).toEqual(cid(7));
      expect(f.received[0]!.data).toEqual(data);
    });

    it("reassembles in-order multi-chunk block", async () => {
      const f = setupFixture();
      const full = new Uint8Array(300);
      for (let i = 0; i < 300; i++) full[i] = i & 0xff;

      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(9),
        block: full.subarray(0, 100),
        offset: 0,
        total: 300,
        last: false,
      });
      expect(f.received).toHaveLength(0);

      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(9),
        block: full.subarray(100, 200),
        offset: 100,
        total: 300,
        last: false,
      });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(9),
        block: full.subarray(200, 300),
        offset: 200,
        total: 300,
        last: true,
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(f.received).toHaveLength(1);
      expect(f.received[0]!.data).toEqual(full);
    });

    it("reassembles out-of-order chunks", async () => {
      const f = setupFixture();
      const full = new Uint8Array([10, 20, 30, 40, 50, 60]);

      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(11),
        block: full.subarray(2, 4),
        offset: 2,
        total: 6,
        last: false,
      });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(11),
        block: full.subarray(0, 2),
        offset: 0,
        total: 6,
        last: false,
      });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(11),
        block: full.subarray(4, 6),
        offset: 4,
        total: 6,
        last: true,
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(f.received).toHaveLength(1);
      expect(f.received[0]!.data).toEqual(full);
    });

    it("NAK clears pending and allows re-request", async () => {
      const f = setupFixture();
      // Receive partial chunk first
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array([1, 2, 3]),
        offset: 0,
        total: 10,
        last: false,
      });
      // NAK
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array(0),
        offset: 0,
        total: 0,
        last: false,
      });
      expect(f.received).toHaveLength(0);

      // After NAK, a fresh catalog should re-request the CID.
      // (requested set cleared the entry.)
      f.exchange.receive({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [{ cid: cid(1), seq: 1, ts: 1 }],
        tip: cid(1),
      });
      const req = f.sent[0]!;
      if (req.type !== MessageType.SNAPSHOT_REQUEST) throw new Error();
      expect(req.cids).toHaveLength(1);
    });

    it("rejects chunk exceeding declared total", async () => {
      const f = setupFixture();
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array(50),
        offset: 80,
        total: 100,
        last: false,
      });
      await Promise.resolve();
      expect(f.received).toHaveLength(0);
    });

    it("rejects total mismatch mid-stream", async () => {
      const f = setupFixture();
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array(10),
        offset: 0,
        total: 100,
        last: false,
      });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array(10),
        offset: 10,
        total: 200,
        last: false,
      });
      // Continue — first state dropped, so no completion.
      await Promise.resolve();
      expect(f.received).toHaveLength(0);
    });

    it("drops block when verify returns false", async () => {
      const f = setupFixture({ verify: async () => false });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array([1, 2, 3]),
        offset: 0,
        total: 3,
        last: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.received).toHaveLength(0);
    });

    it("does not fire onBlock after destroy", async () => {
      let resolveVerify: ((v: boolean) => void) | null = null;
      const verify = () =>
        new Promise<boolean>((r) => {
          resolveVerify = r;
        });

      const f = setupFixture({ verify });
      f.exchange.receive({
        type: MessageType.SNAPSHOT_BLOCK,
        cid: cid(1),
        block: new Uint8Array([1, 2, 3]),
        offset: 0,
        total: 3,
        last: true,
      });
      f.exchange.destroy();
      resolveVerify!(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.received).toHaveLength(0);
    });
  });

  describe("selectCidsToRequest", () => {
    it("prefers tip", () => {
      const selected = selectCidsToRequest(
        {
          type: MessageType.SNAPSHOT_CATALOG,
          entries: [
            { cid: cid(1), seq: 1, ts: 10 },
            { cid: cid(2), seq: 2, ts: 20 },
          ],
          tip: cid(1),
        },
        () => null,
        10,
      );
      expect(selected[0]).toEqual(cid(1));
    });

    it("does not duplicate tip", () => {
      const selected = selectCidsToRequest(
        {
          type: MessageType.SNAPSHOT_CATALOG,
          entries: [
            { cid: cid(1), seq: 1, ts: 10 },
            { cid: cid(2), seq: 2, ts: 20 },
          ],
          tip: cid(2),
        },
        () => null,
        10,
      );
      // Tip first, then cid(1). No duplicates.
      expect(selected).toHaveLength(2);
      expect(selected[0]).toEqual(cid(2));
      expect(selected[1]).toEqual(cid(1));
    });

    it("sorts remaining by descending seq", () => {
      const selected = selectCidsToRequest(
        {
          type: MessageType.SNAPSHOT_CATALOG,
          entries: [
            { cid: cid(1), seq: 1, ts: 10 },
            { cid: cid(2), seq: 3, ts: 30 },
            { cid: cid(3), seq: 2, ts: 20 },
          ],
          tip: null,
        },
        () => null,
        10,
      );
      expect(selected.map((c) => c[0])).toEqual([2, 3, 1]);
    });

    it("applies budget", () => {
      const selected = selectCidsToRequest(
        {
          type: MessageType.SNAPSHOT_CATALOG,
          entries: [
            { cid: cid(1), seq: 1, ts: 1 },
            { cid: cid(2), seq: 2, ts: 2 },
            { cid: cid(3), seq: 3, ts: 3 },
            { cid: cid(4), seq: 4, ts: 4 },
          ],
          tip: cid(4),
        },
        () => null,
        2,
      );
      // Budget 2: tip first + 1 more.
      expect(selected).toHaveLength(2);
      expect(selected[0]).toEqual(cid(4));
    });
  });
});
