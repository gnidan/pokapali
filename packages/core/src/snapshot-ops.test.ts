/**
 * Tests for createSnapshotOps factory — verifies
 * decodeBlock and applySnapshot wiring independently
 * of create-doc.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  createSnapshotOps,
  SnapshotValidationError,
  type SnapshotOpsOptions,
} from "./snapshot-ops.js";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";

// --- Helpers ---

const DAG_CBOR_CODE = 0x71;

async function fakeCid(data: Uint8Array = new Uint8Array([1])): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

function mockResolver(): BlockResolver {
  return {
    get: vi.fn().mockResolvedValue(null),
    getCached: vi.fn().mockReturnValue(null),
    put: vi.fn(),
  };
}

function mockSnapshotCodec(): SnapshotCodec {
  return {
    push: vi.fn(),
    applyRemote: vi.fn().mockResolvedValue(true),
    loadVersion: vi.fn(),
    get prev() {
      return null;
    },
    get seq() {
      return 1;
    },
    get lastIpnsSeq() {
      return null;
    },
    setLastIpnsSeq: vi.fn(),
  } as unknown as SnapshotCodec;
}

function buildOptions(
  overrides?: Partial<SnapshotOpsOptions>,
): SnapshotOpsOptions {
  return {
    snapshotCodec: mockSnapshotCodec(),
    resolver: mockResolver(),
    readKey: {} as CryptoKey,
    getClockSum: () => 42,
    ...overrides,
  };
}

// --- Mock decodeSnapshot ---

vi.mock("@pokapali/blocks", () => ({
  decodeSnapshot: vi.fn(() => ({
    seq: 5,
    prev: null,
    ts: 1700000000000,
    publisher: new Uint8Array([0xab, 0xcd]),
  })),
  validateSnapshot: vi.fn(async () => true),
}));

vi.mock("@pokapali/crypto", () => ({
  bytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  ),
}));

describe("createSnapshotOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----- decodeBlock -----

  describe("decodeBlock", () => {
    it("extracts metadata from a valid block", () => {
      const ops = createSnapshotOps(buildOptions());
      const meta = ops.decodeBlock(new Uint8Array([1, 2, 3]));

      expect(meta.seq).toBe(5);
      expect(meta.snapshotTs).toBe(1700000000000);
      expect(meta.publisher).toBe("abcd");
      expect(meta.prev).toBeUndefined();
    });

    it("returns empty object on decode failure", async () => {
      const { decodeSnapshot } = await import("@pokapali/blocks");
      vi.mocked(decodeSnapshot).mockImplementationOnce(() => {
        throw new Error("corrupt block");
      });

      const ops = createSnapshotOps(buildOptions());
      const meta = ops.decodeBlock(new Uint8Array([0xff]));

      expect(meta).toEqual({});
    });

    it("handles missing publisher field", async () => {
      const { decodeSnapshot } = await import("@pokapali/blocks");
      vi.mocked(decodeSnapshot).mockReturnValueOnce({
        seq: 3,
        prev: null,
        ts: 1700000000000,
        subdocs: {},
        publicKey: new Uint8Array(32),
        signature: new Uint8Array(64),
      });

      const ops = createSnapshotOps(buildOptions());
      const meta = ops.decodeBlock(new Uint8Array([1]));

      expect(meta.seq).toBe(3);
      expect(meta.publisher).toBeUndefined();
    });
  });

  // ----- applySnapshot -----

  describe("applySnapshot", () => {
    it("puts block in resolver and delegates" + " to codec", async () => {
      const resolver = mockResolver();
      const codec = mockSnapshotCodec();
      const ops = createSnapshotOps(
        buildOptions({
          resolver,
          snapshotCodec: codec,
        }),
      );

      const cid = await fakeCid();
      const block = new Uint8Array([1, 2, 3]);
      const result = await ops.applySnapshot(cid, block);

      expect(resolver.put).toHaveBeenCalledWith(cid, block);
      expect(codec.applyRemote).toHaveBeenCalled();
      expect(result).toEqual({ seq: 5 });
    });

    it("sets lastIpnsSeq from getClockSum" + " when applied", async () => {
      const codec = mockSnapshotCodec();
      vi.mocked(codec.applyRemote).mockResolvedValue(true);
      const getClockSum = vi.fn(() => 99);

      const ops = createSnapshotOps(
        buildOptions({
          snapshotCodec: codec,
          getClockSum,
        }),
      );

      const cid = await fakeCid();
      await ops.applySnapshot(cid, new Uint8Array([1]));

      expect(codec.setLastIpnsSeq).toHaveBeenCalledWith(99);
    });

    it("skips setLastIpnsSeq when not applied", async () => {
      const codec = mockSnapshotCodec();
      vi.mocked(codec.applyRemote).mockResolvedValue(false);

      const ops = createSnapshotOps(buildOptions({ snapshotCodec: codec }));

      const cid = await fakeCid();
      await ops.applySnapshot(cid, new Uint8Array([1]));

      expect(codec.setLastIpnsSeq).not.toHaveBeenCalled();
    });
  });

  // ----- Snapshot validation (#216) -----

  describe("applySnapshot validation", () => {
    it(
      "throws SnapshotValidationError when" + " validateSnapshot returns false",
      async () => {
        const { validateSnapshot } = await import("@pokapali/blocks");
        vi.mocked(validateSnapshot).mockResolvedValueOnce(false);

        const ops = createSnapshotOps(buildOptions());
        const cid = await fakeCid();

        await expect(
          ops.applySnapshot(cid, new Uint8Array([1, 2])),
        ).rejects.toThrow(SnapshotValidationError);
      },
    );

    it("does not call applyRemote when" + " validation fails", async () => {
      const { validateSnapshot } = await import("@pokapali/blocks");
      vi.mocked(validateSnapshot).mockResolvedValueOnce(false);

      const codec = mockSnapshotCodec();
      const ops = createSnapshotOps(buildOptions({ snapshotCodec: codec }));
      const cid = await fakeCid();

      await expect(
        ops.applySnapshot(cid, new Uint8Array([1])),
      ).rejects.toThrow();

      expect(codec.applyRemote).not.toHaveBeenCalled();
    });

    it(
      "proceeds normally when validateSnapshot" + " returns true",
      async () => {
        const { validateSnapshot } = await import("@pokapali/blocks");
        vi.mocked(validateSnapshot).mockResolvedValueOnce(true);

        const codec = mockSnapshotCodec();
        const ops = createSnapshotOps(buildOptions({ snapshotCodec: codec }));
        const cid = await fakeCid();
        const result = await ops.applySnapshot(cid, new Uint8Array([1]));

        expect(codec.applyRemote).toHaveBeenCalled();
        expect(result).toEqual({ seq: 5 });
      },
    );

    it("SnapshotValidationError has correct" + " name and includes CID", () => {
      const err = new SnapshotValidationError("bafyabc123");
      expect(err.name).toBe("SnapshotValidationError");
      expect(err.message).toContain("bafyabc123");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
