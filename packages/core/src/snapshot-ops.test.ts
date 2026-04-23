/**
 * Tests for createSnapshotOps factory — verifies the
 * interpreter-facing `applySnapshot` shim correctly
 * maps ingest orchestrator outcomes to the legacy
 * `{seq}` / SnapshotValidationError / PendingIngestError
 * contract the interpreter depends on.
 *
 * Deep validation / dedupe / sideband behavior is
 * covered in ingest-snapshot.test.ts; this test file
 * only exercises the shim layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  createSnapshotOps,
  SnapshotValidationError,
  type SnapshotOpsOptions,
} from "./snapshot-ops.js";
import {
  PendingIngestError,
  type IngestResult,
  type IngestSnapshotApi,
} from "./ingest-snapshot.js";
// --- Helpers ---

const DAG_CBOR_CODE = 0x71;

async function fakeCid(data: Uint8Array = new Uint8Array([1])): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

function stubIngest(
  result: IngestResult = { outcome: "placed" },
): IngestSnapshotApi & { calls: number } {
  const api = {
    ingestSnapshot: vi.fn(async () => result),
    rescanPending: vi.fn(async () => undefined),
    pendingSize: 0,
    calls: 0,
  };
  return api as unknown as IngestSnapshotApi & { calls: number };
}

function buildOptions(
  overrides?: Partial<SnapshotOpsOptions>,
): SnapshotOpsOptions {
  return {
    ingest: stubIngest(),
    resolveSource: () => "peer",
    ...overrides,
  };
}

// --- Mock decodeSnapshot (still used by decodeBlock +
//     the seq decode at the end of applySnapshot shim). ---

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

  // ----- applySnapshot shim -----

  describe("applySnapshot", () => {
    it(
      "delegates to ingest.ingestSnapshot with " + "resolved source",
      async () => {
        const ingest = stubIngest({ outcome: "placed" });
        const resolveSource = vi.fn(() => "local" as const);
        const ops = createSnapshotOps(buildOptions({ ingest, resolveSource }));

        const cid = await fakeCid();
        const block = new Uint8Array([1, 2, 3]);
        const result = await ops.applySnapshot(cid, block);

        expect(resolveSource).toHaveBeenCalledWith(cid);
        expect(ingest.ingestSnapshot).toHaveBeenCalledWith(cid, block, {
          source: "local",
        });
        expect(result).toEqual({ seq: 5 });
      },
    );

    it("returns {seq} on placed outcome", async () => {
      const ingest = stubIngest({ outcome: "placed" });
      const ops = createSnapshotOps(buildOptions({ ingest }));
      const cid = await fakeCid();
      const result = await ops.applySnapshot(cid, new Uint8Array([1]));
      expect(result).toEqual({ seq: 5 });
    });

    it("returns {seq} on duplicate (no-op success " + "contract)", async () => {
      const ingest = stubIngest({
        outcome: "rejected",
        reason: "duplicate",
      });
      const ops = createSnapshotOps(buildOptions({ ingest }));
      const cid = await fakeCid();
      const result = await ops.applySnapshot(cid, new Uint8Array([1]));
      expect(result).toEqual({ seq: 5 });
    });

    it("throws SnapshotValidationError on " + "invalid-signature", async () => {
      const ingest = stubIngest({
        outcome: "rejected",
        reason: "invalid-signature",
      });
      const ops = createSnapshotOps(buildOptions({ ingest }));
      const cid = await fakeCid();
      await expect(ops.applySnapshot(cid, new Uint8Array([1]))).rejects.toThrow(
        SnapshotValidationError,
      );
    });

    it("throws SnapshotValidationError on " + "cid-mismatch", async () => {
      const ingest = stubIngest({
        outcome: "rejected",
        reason: "cid-mismatch",
      });
      const ops = createSnapshotOps(buildOptions({ ingest }));
      const cid = await fakeCid();
      await expect(ops.applySnapshot(cid, new Uint8Array([1]))).rejects.toThrow(
        SnapshotValidationError,
      );
    });

    it("throws PendingIngestError on pending " + "outcome", async () => {
      const ingest = stubIngest({
        outcome: "pending",
        reason: "unplaceable-epoch",
      });
      const ops = createSnapshotOps(buildOptions({ ingest }));
      const cid = await fakeCid();
      await expect(ops.applySnapshot(cid, new Uint8Array([1]))).rejects.toThrow(
        PendingIngestError,
      );
    });

    it("SnapshotValidationError has correct" + " name and includes CID", () => {
      const err = new SnapshotValidationError("bafyabc123");
      expect(err.name).toBe("SnapshotValidationError");
      expect(err.message).toContain("bafyabc123");
      expect(err).toBeInstanceOf(Error);
    });

    it("PendingIngestError has correct name " + "and includes CID", () => {
      const err = new PendingIngestError("bafyxyz789");
      expect(err.name).toBe("PendingIngestError");
      expect(err.message).toContain("bafyxyz789");
      expect(err.cid).toBe("bafyxyz789");
    });
  });
});
