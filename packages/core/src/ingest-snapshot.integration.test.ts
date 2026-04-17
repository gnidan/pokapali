/**
 * Integration tests for the ingestSnapshot pipeline.
 *
 * Tests the boundary between `snapshotOps.applySnapshot`
 * (the interpreter-facing facade) and the underlying
 * `createIngestSnapshot` orchestrator. Validates:
 *   - source dispatch (local vs peer) via resolveSource
 *   - error mapping (PendingIngestError,
 *     SnapshotValidationError, benign duplicate)
 *   - onIngestOutcome emission shape
 *   - rescan cycle (pending → bridge → placed)
 *   - sideband overflow → terminal rejection
 *
 * Uses `createStubBlockResolver` from the A0 test harness
 * (first real consumer), `stubCodec` inline (minimal
 * surface the orchestrator touches).
 *
 * FailureStore/FailureRecord invariants (D3 second wave)
 * gated on A2 merge.
 *
 * S54 D3 — paired with core A3 (!452) + A4 (!453).
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
import { encodeSnapshot } from "@pokapali/blocks";
import type { ChainEntry, ChainState } from "./facts.js";
import type { SnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import {
  createIngestSnapshot,
  PendingIngestError,
  type IngestOutcomeRecord,
} from "./ingest-snapshot.js";
import { createSnapshotOps, SnapshotValidationError } from "./snapshot-ops.js";
import { createStubBlockResolver } from "./test/stub-block-resolver.js";

const DAG_CBOR = 0x71;

// --- Crypto helpers (shared pattern with
//     ingest-snapshot.test.ts) ---

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
  ydoc.getText("content").insert(0, "seq " + seq);
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
  const cid = CID.createV1(DAG_CBOR, hash);
  return { cid, block };
}

// --- Chain state helper ---

function chainWithEntries(keys: Iterable<string>): ChainState {
  const entries = new Map<string, ChainEntry>();
  for (const k of keys) {
    entries.set(k, {
      cid: { toString: () => k } as unknown as CID,
      discoveredVia: new Set(),
      blockStatus: "applied",
      fetchAttempt: 0,
      guarantees: new Map(),
      ackedBy: new Set(),
    });
  }
  return {
    entries,
    tip: null,
    applying: null,
    newestFetched: null,
    maxSeq: 0,
  };
}

/** Mutable chain state. */
function makeState(initialApplied: Iterable<string> = []) {
  let chain = chainWithEntries(initialApplied);
  return {
    getState: () => ({ chain }),
    markApplied(cidStr: string) {
      const next = new Map(chain.entries);
      const existing = next.get(cidStr);
      next.set(cidStr, {
        cid: {
          toString: () => cidStr,
        } as unknown as CID,
        discoveredVia: existing?.discoveredVia ?? new Set(),
        blockStatus: "applied" as const,
        fetchAttempt: existing?.fetchAttempt ?? 0,
        guarantees: existing?.guarantees ?? new Map(),
        ackedBy: existing?.ackedBy ?? new Set(),
      });
      chain = { ...chain, entries: next };
    },
  };
}

// --- Stub codec (minimal SnapshotCodec surface
//     the orchestrator touches) ---

function stubCodec(resolver: BlockResolver): SnapshotCodec & {
  applyRemoteCalls: number;
} {
  let lastIpnsSeq: number | null = null;
  let applyRemoteCalls = 0;
  const applied = new Set<string>();
  const codec: SnapshotCodec & {
    applyRemoteCalls: number;
  } = {
    push: vi.fn(),
    async applyRemote(cid, _readKey, onApply) {
      applyRemoteCalls++;
      codec.applyRemoteCalls = applyRemoteCalls;
      const key = cid.toString();
      if (applied.has(key)) return false;
      const block = await resolver.get(cid);
      if (!block) return false;
      applied.add(key);
      onApply({});
      return true;
    },
    loadVersion: vi.fn().mockResolvedValue({}),
    get prev() {
      return null;
    },
    get seq() {
      return 1;
    },
    get lastIpnsSeq() {
      return lastIpnsSeq;
    },
    setLastIpnsSeq(s: number) {
      lastIpnsSeq = s;
    },
    applyRemoteCalls: 0,
  };
  return codec;
}

// --- Integration wiring ---

/**
 * Wire `createSnapshotOps` on top of
 * `createIngestSnapshot` — the integration boundary
 * the interpreter calls through.
 */
async function wireIntegration(opts?: { sidebandMaxEntries?: number }) {
  const { keys, signingKey } = await generateKeys();
  const resolver = createStubBlockResolver();
  const snapshotCodec = stubCodec(resolver);
  const state = makeState();
  const outcomes: IngestOutcomeRecord[] = [];

  const ingest = createIngestSnapshot({
    snapshotCodec,
    resolver,
    readKey: keys.readKey,
    getClockSum: () => 42,
    getState: state.getState,
    onIngestOutcome: (r) => outcomes.push(r),
    sidebandOptions: opts?.sidebandMaxEntries
      ? { maxEntries: opts.sidebandMaxEntries }
      : undefined,
  });

  // Track the last-local-publish CID the way
  // doc-runtime does (closure over a mutable string).
  let lastLocalPublishCid: string | null = null;

  const snapshotOps = createSnapshotOps({
    ingest,
    resolveSource: (cid) =>
      lastLocalPublishCid !== null && cid.toString() === lastLocalPublishCid
        ? "local"
        : "peer",
  });

  return {
    keys,
    signingKey,
    resolver,
    snapshotCodec,
    state,
    outcomes,
    ingest,
    snapshotOps,
    setLocalPublishCid(cid: string) {
      lastLocalPublishCid = cid;
    },
  };
}

// --- Tests ---

describe("ingestSnapshot integration", () => {
  describe("source dispatch via snapshotOps", () => {
    it(
      "tags source as 'local' when CID matches " + "lastLocalPublishCid",
      async () => {
        const { keys, signingKey, snapshotOps, outcomes, setLocalPublishCid } =
          await wireIntegration();
        const { cid, block } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );

        setLocalPublishCid(cid.toString());
        await snapshotOps.applySnapshot(cid, block);

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          outcome: "placed",
          source: "local",
          fromRescan: false,
        });
      },
    );

    it(
      "tags source as 'peer' when CID does not match " + "lastLocalPublishCid",
      async () => {
        const { keys, signingKey, snapshotOps, outcomes } =
          await wireIntegration();
        const { cid, block } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );

        // No setLocalPublishCid → defaults to "peer".
        await snapshotOps.applySnapshot(cid, block);

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({
          outcome: "placed",
          source: "peer",
          fromRescan: false,
        });
      },
    );
  });

  describe("error mapping through snapshotOps", () => {
    it(
      "throws PendingIngestError for unplaceable " +
        "epoch; block still in resolver",
      async () => {
        const { keys, signingKey, snapshotOps, resolver, outcomes } =
          await wireIntegration();
        const { cid: parentCid } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );
        const { cid: childCid, block: childBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          2,
          parentCid,
        );

        await expect(
          snapshotOps.applySnapshot(childCid, childBlock),
        ).rejects.toThrow(PendingIngestError);

        // Block persisted to resolver despite pending
        // (spec §Sideband-pending interaction).
        expect(resolver.has(childCid)).toBe(true);
        expect(outcomes[0]).toMatchObject({
          outcome: "pending",
          reason: "unplaceable-epoch",
        });
      },
    );

    it("throws SnapshotValidationError on " + "cid-mismatch", async () => {
      const { keys, signingKey, snapshotOps, outcomes } =
        await wireIntegration();
      const { block } = await encodeValidBlock(
        keys.readKey,
        signingKey,
        1,
        null,
      );
      // Wrong CID for these bytes.
      const wrongHash = await sha256.digest(new Uint8Array([0x00, 0x01]));
      const wrongCid = CID.createV1(DAG_CBOR, wrongHash);

      await expect(snapshotOps.applySnapshot(wrongCid, block)).rejects.toThrow(
        SnapshotValidationError,
      );

      expect(outcomes[0]).toMatchObject({
        outcome: "rejected",
        reason: "cid-mismatch",
      });
    });

    it(
      "duplicate returns {seq} without throwing; " +
        "onIngestOutcome records 'duplicate'",
      async () => {
        const { keys, signingKey, snapshotOps, outcomes } =
          await wireIntegration();
        const { cid, block } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );

        // First ingest → placed.
        const r1 = await snapshotOps.applySnapshot(cid, block);
        expect(r1).toHaveProperty("seq", 1);

        // Second ingest → duplicate, no throw.
        const r2 = await snapshotOps.applySnapshot(cid, block);
        expect(r2).toHaveProperty("seq", 1);

        expect(outcomes).toHaveLength(2);
        expect(outcomes[1]).toMatchObject({
          outcome: "rejected",
          reason: "duplicate",
        });
      },
    );
  });

  describe("rescan cycle (sideband → bridge → placed)", () => {
    it(
      "rescanPending places a previously-unplaceable " +
        "snapshot after bridging epoch arrives",
      async () => {
        const {
          keys,
          signingKey,
          snapshotOps,
          ingest,
          state,
          outcomes,
          snapshotCodec,
        } = await wireIntegration();

        // Parent + child: child's prev points to parent.
        const { cid: parentCid, block: parentBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );
        const { cid: childCid, block: childBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          2,
          parentCid,
        );

        // Child arrives first → pending.
        await expect(
          snapshotOps.applySnapshot(childCid, childBlock),
        ).rejects.toThrow(PendingIngestError);
        expect(ingest.pendingSize).toBe(1);

        // Parent arrives + places.
        await snapshotOps.applySnapshot(parentCid, parentBlock);
        state.markApplied(parentCid.toString());

        // Simulate reconcile-cycle-end callback.
        await ingest.rescanPending();

        // Child placed via rescan.
        expect(ingest.pendingSize).toBe(0);

        const rescanOutcome = outcomes.find(
          (r) => r.fromRescan && r.outcome === "placed",
        );
        expect(rescanOutcome).toBeDefined();
        expect(rescanOutcome?.cid.toString()).toBe(childCid.toString());

        // Rescan-placed blocks skip applyRemote — the
        // interpreter rediscovers the CID in its next
        // cycle. Only the parent's first-ingest
        // applied eagerly (1 call total).
        expect(snapshotCodec.applyRemoteCalls).toBe(1);
      },
    );

    it(
      "rescan emits fromRescan: true with correct " +
        "source/peerId provenance",
      async () => {
        const { keys, signingKey, ingest, state, outcomes } =
          await wireIntegration();

        const { cid: parentCid, block: parentBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );
        const { cid: childCid, block: childBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          2,
          parentCid,
        );

        // Ingest child directly (not via snapshotOps)
        // with explicit peerId to verify provenance
        // survives the sideband round-trip.
        await ingest.ingestSnapshot(childCid, childBlock, {
          source: "peer",
          peerId: "peer-42",
        });
        expect(ingest.pendingSize).toBe(1);

        // Bridge.
        await ingest.ingestSnapshot(parentCid, parentBlock, { source: "peer" });
        state.markApplied(parentCid.toString());

        await ingest.rescanPending();

        const rescan = outcomes.find((r) => r.fromRescan);
        expect(rescan).toMatchObject({
          outcome: "placed",
          source: "peer",
          peerId: "peer-42",
          fromRescan: true,
        });
      },
    );
  });

  describe("sideband overflow", () => {
    it(
      "FIFO eviction emits terminal " +
        "'pending-overflow' via onIngestOutcome",
      async () => {
        const { keys, signingKey, ingest, outcomes } = await wireIntegration({
          sidebandMaxEntries: 1,
        });

        // Two children with different unknown parents.
        const { cid: parentA } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );
        const { cid: childA, block: childABlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          2,
          parentA,
        );
        const { cid: parentB } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          3,
          null,
        );
        const { cid: childB, block: childBBlock } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          4,
          parentB,
        );

        // First child → pending (fills the 1-slot cap).
        await ingest.ingestSnapshot(childA, childABlock, {
          source: "peer",
          peerId: "peer-A",
        });
        expect(ingest.pendingSize).toBe(1);

        // Second child → evicts first.
        await ingest.ingestSnapshot(childB, childBBlock, {
          source: "peer",
          peerId: "peer-B",
        });
        expect(ingest.pendingSize).toBe(1);

        const overflow = outcomes.find((r) => r.reason === "pending-overflow");
        expect(overflow).toBeDefined();
        expect(overflow).toMatchObject({
          outcome: "rejected",
          reason: "pending-overflow",
          peerId: "peer-A",
        });
      },
    );
  });

  describe("onIngestOutcome shape invariants", () => {
    it(
      "every outcome record has cid, ts, outcome, " + "source, and fromRescan",
      async () => {
        const { keys, signingKey, snapshotOps, outcomes } =
          await wireIntegration();

        // Place a block.
        const { cid, block } = await encodeValidBlock(
          keys.readKey,
          signingKey,
          1,
          null,
        );
        await snapshotOps.applySnapshot(cid, block);

        // Duplicate.
        await snapshotOps.applySnapshot(cid, block);

        expect(outcomes).toHaveLength(2);
        for (const r of outcomes) {
          expect(r.cid).toBeDefined();
          expect(typeof r.ts).toBe("number");
          expect(r.ts).toBeGreaterThan(0);
          expect(["placed", "pending", "rejected"]).toContain(r.outcome);
          expect(["local", "peer"]).toContain(r.source);
          expect(typeof r.fromRescan).toBe("boolean");
        }
      },
    );
  });
});
