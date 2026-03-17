/**
 * Tests for createSnapshotOps factory — verifies
 * decodeBlock, applySnapshot, and
 * isPublisherAuthorized wiring independently of
 * create-doc.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createSnapshotOps, type SnapshotOpsOptions } from "./snapshot-ops.js";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import type { SubdocManager } from "@pokapali/subdocs";

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

function mockSubdocManager(): SubdocManager {
  const metaDoc = new Y.Doc({ guid: "test:_meta" });
  return {
    subdoc: vi.fn(),
    metaDoc,
    encodeAll: vi.fn(() => ({})),
    applySnapshot: vi.fn(),
    isDirty: false,
    on: vi.fn(),
    off: vi.fn(),
    whenLoaded: Promise.resolve(),
    destroy: vi.fn(),
  } as unknown as SubdocManager;
}

function buildOptions(
  overrides?: Partial<SnapshotOpsOptions>,
): SnapshotOpsOptions {
  return {
    snapshotCodec: mockSnapshotCodec(),
    subdocManager: mockSubdocManager(),
    resolver: mockResolver(),
    readKey: {} as CryptoKey,
    getClockSum: () => 42,
    ...overrides,
  };
}

// --- Mock decodeSnapshot ---

vi.mock("@pokapali/snapshot", () => ({
  decodeSnapshot: vi.fn(() => ({
    seq: 5,
    prev: null,
    ts: 1700000000000,
    publisher: new Uint8Array([0xab, 0xcd]),
  })),
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
      const { decodeSnapshot } = await import("@pokapali/snapshot");
      vi.mocked(decodeSnapshot).mockImplementationOnce(() => {
        throw new Error("corrupt block");
      });

      const ops = createSnapshotOps(buildOptions());
      const meta = ops.decodeBlock(new Uint8Array([0xff]));

      expect(meta).toEqual({});
    });

    it("handles missing publisher field", async () => {
      const { decodeSnapshot } = await import("@pokapali/snapshot");
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

  // ----- isPublisherAuthorized -----

  describe("isPublisherAuthorized", () => {
    it(
      "returns true when no publishers" + " configured (permissionless)",
      () => {
        const ops = createSnapshotOps(buildOptions());
        expect(ops.isPublisherAuthorized("aabbcc")).toBe(true);
      },
    );

    it("returns true for listed publisher", () => {
      const sdm = mockSubdocManager();
      sdm.metaDoc.getMap<true>("authorizedPublishers").set("aabbcc", true);

      const ops = createSnapshotOps(buildOptions({ subdocManager: sdm }));

      expect(ops.isPublisherAuthorized("aabbcc")).toBe(true);
    });

    it("returns false for unlisted publisher", () => {
      const sdm = mockSubdocManager();
      sdm.metaDoc.getMap<true>("authorizedPublishers").set("aabbcc", true);

      const ops = createSnapshotOps(buildOptions({ subdocManager: sdm }));

      expect(ops.isPublisherAuthorized("ddeeff")).toBe(false);
    });

    it(
      "returns false for undefined publisher" + " when auth is configured",
      () => {
        const sdm = mockSubdocManager();
        sdm.metaDoc.getMap<true>("authorizedPublishers").set("aabbcc", true);

        const ops = createSnapshotOps(buildOptions({ subdocManager: sdm }));

        expect(ops.isPublisherAuthorized(undefined)).toBe(false);
      },
    );
  });
});
