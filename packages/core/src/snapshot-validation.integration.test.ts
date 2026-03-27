/**
 * Consumer-perspective integration tests for M1
 * snapshot validation (#216).
 *
 * Exercises the real cross-package validation path:
 * @pokapali/crypto (key generation) →
 * @pokapali/blocks (encode + validateSnapshot) →
 * @pokapali/core snapshot-ops (SnapshotValidationError)
 * → interpreter (graceful degradation).
 *
 * No mocks for crypto or validation — these use real
 * keys and real signature verification.
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot, validateSnapshot } from "@pokapali/blocks";
import { createSnapshotOps, SnapshotValidationError } from "./snapshot-ops.js";
import { ValidationError } from "./errors.js";
import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers } from "./interpreter.js";
import { initialDocState } from "./facts.js";
import type { Fact } from "./facts.js";
import { reduce } from "./reducers.js";
import { createAsyncQueue, merge, scan } from "./sources.js";

// --- Constants ---

const DAG_CBOR_CODE = 0x71;

const IDENTITY = {
  ipnsName: "test-validation",
  role: "writer" as const,
  channels: ["content"],
  appId: "test-app",
};

// --- Helpers ---

async function generateKeys() {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, "test-app", ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  return { keys, signingKey };
}

async function encodeValidBlock(
  readKey: CryptoKey,
  signingKey: Awaited<ReturnType<typeof ed25519KeyPairFromSeed>>,
  seq: number,
  prev: CID | null = null,
): Promise<{ cid: CID; block: Uint8Array }> {
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, "hello from seq " + seq);
  const state = Y.encodeStateAsUpdate(ydoc);
  const block = await encodeSnapshot(
    { content: state },
    readKey,
    prev,
    seq,
    Date.now(),
    signingKey,
  );
  const hash = await sha256.digest(block);
  const cid = CID.createV1(DAG_CBOR_CODE, hash);
  return { cid, block };
}

async function fakeCid(n: number): Promise<CID> {
  const hash = await sha256.digest(new Uint8Array([n]));
  return CID.createV1(DAG_CBOR_CODE, hash);
}

/**
 * Minimal mock of SnapshotCodec — only applyRemote
 * and setLastIpnsSeq are called in the apply path.
 */
function mockSnapshotCodec() {
  return {
    push: vi.fn(),
    applyRemote: vi.fn().mockResolvedValue(true),
    loadVersion: vi.fn().mockResolvedValue({}),
    prev: null,
    seq: 1,
    lastIpnsSeq: null as number | null,
    setLastIpnsSeq: vi.fn(),
  };
}

function mockSubdocManager() {
  const metaDoc = new Y.Doc();
  return {
    applySnapshot: vi.fn(),
    getPlaintext: vi.fn().mockReturnValue({}),
    metaDoc,
  };
}

function mockBlockResolver() {
  const blocks = new Map<string, Uint8Array>();
  return {
    get: vi.fn(async (cid: CID) => blocks.get(cid.toString()) ?? null),
    getCached: vi.fn((cid: CID) => blocks.get(cid.toString()) ?? null),
    put: vi.fn((cid: CID, block: Uint8Array) => {
      blocks.set(cid.toString(), block);
    }),
  };
}

// --- Tests ---

describe("snapshot validation integration", () => {
  describe("validateSnapshot with real crypto", () => {
    it("accepts a validly signed snapshot block", async () => {
      const { keys, signingKey } = await generateKeys();
      const { block } = await encodeValidBlock(keys.readKey, signingKey, 1);

      const valid = await validateSnapshot(block);
      expect(valid).toBe(true);
    });

    it("rejects a snapshot with tampered signature", async () => {
      const { keys, signingKey } = await generateKeys();
      const { block } = await encodeValidBlock(keys.readKey, signingKey, 1);

      // Tamper: flip bytes near the end where the
      // signature lives
      const tampered = new Uint8Array(block);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
      tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;

      const valid = await validateSnapshot(tampered);
      expect(valid).toBe(false);
    });

    it("rejects garbage bytes", async () => {
      const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

      const valid = await validateSnapshot(garbage);
      expect(valid).toBe(false);
    });
  });

  describe("createSnapshotOps.applySnapshot", () => {
    it("applies a valid snapshot without error", async () => {
      const { keys, signingKey } = await generateKeys();
      const { cid, block } = await encodeValidBlock(
        keys.readKey,
        signingKey,
        1,
      );

      const ops = createSnapshotOps({
        snapshotCodec: mockSnapshotCodec(),
        subdocManager: mockSubdocManager() as any,
        resolver: mockBlockResolver() as any,
        readKey: keys.readKey,
        getClockSum: () => 0,
      });

      const result = await ops.applySnapshot(cid, block);
      expect(result.seq).toBe(1);
    });

    it("throws SnapshotValidationError for " + "tampered block", async () => {
      const { keys, signingKey } = await generateKeys();
      const { cid, block } = await encodeValidBlock(
        keys.readKey,
        signingKey,
        1,
      );

      const tampered = new Uint8Array(block);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

      const ops = createSnapshotOps({
        snapshotCodec: mockSnapshotCodec(),
        subdocManager: mockSubdocManager() as any,
        resolver: mockBlockResolver() as any,
        readKey: keys.readKey,
        getClockSum: () => 0,
      });

      // Recompute CID for tampered block
      const hash = await sha256.digest(tampered);
      const tamperedCid = CID.createV1(DAG_CBOR_CODE, hash);

      await expect(ops.applySnapshot(tamperedCid, tampered)).rejects.toThrow(
        SnapshotValidationError,
      );
    });

    it("throws SnapshotValidationError for " + "garbage bytes", async () => {
      const cid = await fakeCid(99);
      const garbage = new Uint8Array([0, 1, 2, 3]);

      const { keys } = await generateKeys();
      const ops = createSnapshotOps({
        snapshotCodec: mockSnapshotCodec(),
        subdocManager: mockSubdocManager() as any,
        resolver: mockBlockResolver() as any,
        readKey: keys.readKey,
        getClockSum: () => 0,
      });

      await expect(ops.applySnapshot(cid, garbage)).rejects.toThrow(
        SnapshotValidationError,
      );
    });

    it("does not call applyRemote when " + "validation fails", async () => {
      const cid = await fakeCid(98);
      const garbage = new Uint8Array([0, 1, 2, 3]);

      const { keys } = await generateKeys();
      const codec = mockSnapshotCodec();
      const ops = createSnapshotOps({
        snapshotCodec: codec,
        subdocManager: mockSubdocManager() as any,
        resolver: mockBlockResolver() as any,
        readKey: keys.readKey,
        getClockSum: () => 0,
      });

      await expect(ops.applySnapshot(cid, garbage)).rejects.toThrow();

      expect(codec.applyRemote).not.toHaveBeenCalled();
    });
  });

  describe("error type hierarchy", () => {
    it("SnapshotValidationError extends " + "ValidationError", () => {
      const err = new SnapshotValidationError("bafytest123");
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(Error);
    });

    it("includes CID in message and .cid field", () => {
      const cidStr = "bafyabc456";
      const err = new SnapshotValidationError(cidStr);
      expect(err.cid).toBe(cidStr);
      expect(err.message).toContain(cidStr);
    });

    it(
      "has name SnapshotValidationError for " + "consumer instanceof checks",
      () => {
        const err = new SnapshotValidationError("x");
        expect(err.name).toBe("SnapshotValidationError");
      },
    );
  });

  describe("interpreter graceful degradation", () => {
    /**
     * Wire the real interpreter pipeline with an
     * applySnapshot that calls real validateSnapshot,
     * then delegates to a mock for the actual apply.
     * This tests the full path: invalid block →
     * SnapshotValidationError → interpreter catch →
     * doc stays alive.
     */

    function mockEffects(overrides?: Partial<EffectHandlers>): EffectHandlers {
      return {
        fetchBlock: vi.fn().mockResolvedValue(null),
        applySnapshot: vi.fn().mockResolvedValue({ seq: 1 }),
        getBlock: vi.fn().mockReturnValue(null),
        decodeBlock: vi.fn().mockReturnValue({}),
        isPublisherAuthorized: vi.fn().mockReturnValue(true),
        announce: vi.fn(),
        markReady: vi.fn(),
        emitSnapshotApplied: vi.fn(),
        emitAck: vi.fn(),
        emitGossipActivity: vi.fn(),
        emitLoading: vi.fn(),
        emitGuarantee: vi.fn(),
        emitValidationError: vi.fn(),
        ...overrides,
      };
    }

    function settle(ms = 50): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }

    it(
      "skips invalid snapshot and continues " + "processing valid ones",
      async () => {
        const { keys, signingKey } = await generateKeys();

        // Create a valid block
        const { cid: validCid, block: validBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          2,
        );

        // Create a tampered block
        const { cid: _origCid, block: origBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
        );
        const tampered = new Uint8Array(origBlock);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
        const tamperedHash = await sha256.digest(tampered);
        const tamperedCid = CID.createV1(DAG_CBOR_CODE, tamperedHash);

        // Build an applySnapshot that uses real
        // validateSnapshot
        const realApply = async (cid: CID, block: Uint8Array) => {
          const valid = await validateSnapshot(block);
          if (!valid) {
            throw new SnapshotValidationError(cid.toString());
          }
          return { seq: cid === validCid ? 2 : 1 };
        };

        const effects = mockEffects({
          applySnapshot: vi.fn(realApply),
          getBlock: vi.fn((cid: CID) => {
            const cidStr = cid.toString();
            if (cidStr === tamperedCid.toString()) {
              return tampered;
            }
            if (cidStr === validCid.toString()) {
              return validBlock;
            }
            return null;
          }),
          decodeBlock: vi.fn((block: Uint8Array) => {
            if (block === tampered) {
              return { seq: 1, snapshotTs: 1000 };
            }
            if (block === validBlock) {
              return { seq: 2, snapshotTs: 2000 };
            }
            return {};
          }),
        });

        const ac = new AbortController();
        const input = createAsyncQueue<Fact>(ac.signal);
        const feedback = createAsyncQueue<Fact>(ac.signal);
        const merged = merge(input, feedback);
        const stateStream = scan(merged, reduce, initialDocState(IDENTITY));
        const done = runInterpreter(stateStream, effects, feedback, ac.signal);

        // First: push invalid snapshot
        input.push({
          type: "cid-discovered",
          ts: 1,
          cid: tamperedCid,
          source: "gossipsub",
          block: tampered,
          seq: 1,
          snapshotTs: 1000,
        });

        await settle(100);

        // Interpreter should have tried to apply it
        expect(effects.applySnapshot).toHaveBeenCalledWith(
          tamperedCid,
          tampered,
        );
        // But should NOT have emitted snapshot-applied
        expect(effects.emitSnapshotApplied).not.toHaveBeenCalled();

        // Now push a valid snapshot — doc should
        // still be alive and process it
        input.push({
          type: "cid-discovered",
          ts: 2,
          cid: validCid,
          source: "gossipsub",
          block: validBlock,
          seq: 2,
          snapshotTs: 2000,
        });

        await settle(100);
        ac.abort();
        await done;

        // Valid snapshot should have been applied
        expect(effects.applySnapshot).toHaveBeenCalledWith(
          validCid,
          validBlock,
        );
        // markReady should have been called (first
        // successful tip)
        expect(effects.markReady).toHaveBeenCalled();
      },
    );

    it("doc does not crash on garbage block " + "injection", async () => {
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const garbageCid = await fakeCid(77);

      const realApply = async (cid: CID, block: Uint8Array) => {
        const valid = await validateSnapshot(block);
        if (!valid) {
          throw new SnapshotValidationError(cid.toString());
        }
        return { seq: 1 };
      };

      const effects = mockEffects({
        applySnapshot: vi.fn(realApply),
        getBlock: vi.fn((cid: CID) =>
          cid.toString() === garbageCid.toString() ? garbage : null,
        ),
        decodeBlock: vi.fn(() => ({ seq: 1 })),
      });

      const ac = new AbortController();
      const input = createAsyncQueue<Fact>(ac.signal);
      const feedback = createAsyncQueue<Fact>(ac.signal);
      const merged = merge(input, feedback);
      const stateStream = scan(merged, reduce, initialDocState(IDENTITY));
      const done = runInterpreter(stateStream, effects, feedback, ac.signal);

      // Inject garbage
      input.push({
        type: "cid-discovered",
        ts: 1,
        cid: garbageCid,
        source: "gossipsub",
        block: garbage,
      });

      await settle(100);

      // Interpreter should still be alive — push
      // another fact to confirm
      input.push({
        type: "gossip-subscribed",
        ts: 2,
      });

      await settle(50);
      ac.abort();
      await done;

      // The interpreter processed the gossip-
      // subscribed fact (emits gossip activity)
      expect(effects.emitGossipActivity).toHaveBeenCalled();
      // Invalid snapshot was not applied
      expect(effects.emitSnapshotApplied).not.toHaveBeenCalled();
    });
  });
});
