/**
 * Unit tests for ingest-snapshot:
 *   - isPlaceable (structural placement predicate)
 *   - createPendingSideband (bounded FIFO quarantine)
 *   - createIngestSnapshot orchestrator (validate +
 *     dedupe + place/defer + outcome emission)
 *
 * Cross-package behavior (real codec + real interpreter
 * feedback loop) is exercised by integration tests
 * alongside doc-runtime.
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
  isPlaceable,
  createPendingSideband,
  createIngestSnapshot,
} from "./ingest-snapshot.js";

const DAG_CBOR = 0x71;

// --- Helpers (shared patterns with
//     snapshot-validation.integration.test.ts) ---

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

/** Minimal chain state with the given CID strings
 *  marked as known entries. */
function chainWithEntries(keys: Iterable<string>): ChainState {
  const entries = new Map<string, ChainEntry>();
  for (const k of keys) {
    // ChainEntry requires full shape; only `entries`
    // Map membership matters for isPlaceable.
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

// --- isPlaceable ---

describe("isPlaceable", () => {
  it("returns true for a genesis-adjacent snapshot (prev=null)", async () => {
    const { keys, signingKey } = await generateKeys();
    const { block } = await encodeValidBlock(keys.readKey, signingKey, 1, null);
    const state = { chain: chainWithEntries([]) };
    expect(isPlaceable(block, state)).toBe(true);
  });

  it("returns true when parent CID is in chain.entries", async () => {
    const { keys, signingKey } = await generateKeys();
    const { cid: parentCid } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      1,
      null,
    );
    const { block: childBlock } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      2,
      parentCid,
    );
    const state = { chain: chainWithEntries([parentCid.toString()]) };
    expect(isPlaceable(childBlock, state)).toBe(true);
  });

  it("returns false when parent CID is missing from chain.entries", async () => {
    const { keys, signingKey } = await generateKeys();
    const { cid: parentCid } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      1,
      null,
    );
    const { block: childBlock } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      2,
      parentCid,
    );
    // chain is empty — parent unknown
    const state = { chain: chainWithEntries([]) };
    expect(isPlaceable(childBlock, state)).toBe(false);
  });

  it("returns false for undecodable bytes", () => {
    const junk = new Uint8Array([0xff, 0xfe, 0xfd]);
    const state = { chain: chainWithEntries([]) };
    expect(isPlaceable(junk, state)).toBe(false);
  });
});

// --- createPendingSideband ---

describe("createPendingSideband", () => {
  it("tracks size and totalBytes on add/remove", () => {
    const sb = createPendingSideband();
    expect(sb.size).toBe(0);
    expect(sb.totalBytes).toBe(0);

    sb.add("a", new Uint8Array(100));
    sb.add("b", new Uint8Array(50));
    expect(sb.size).toBe(2);
    expect(sb.totalBytes).toBe(150);

    sb.remove("a");
    expect(sb.size).toBe(1);
    expect(sb.totalBytes).toBe(50);
    expect(sb.has("a")).toBe(false);
    expect(sb.has("b")).toBe(true);
  });

  it("treats duplicate add as no-op", () => {
    const sb = createPendingSideband();
    sb.add("a", new Uint8Array(100));
    sb.add("a", new Uint8Array(999));
    expect(sb.size).toBe(1);
    expect(sb.totalBytes).toBe(100);
  });

  it("remove() on missing CID is a no-op", () => {
    const sb = createPendingSideband();
    sb.add("a", new Uint8Array(100));
    sb.remove("does-not-exist");
    expect(sb.size).toBe(1);
    expect(sb.totalBytes).toBe(100);
  });

  it("preserves insertion order in entries()", () => {
    const sb = createPendingSideband();
    sb.add("a", new Uint8Array([1]));
    sb.add("b", new Uint8Array([2]));
    sb.add("c", new Uint8Array([3]));
    const keys = Array.from(sb.entries()).map(([k]) => k);
    expect(keys).toEqual(["a", "b", "c"]);
  });

  it("FIFO-evicts oldest when maxEntries cap is exceeded", () => {
    const onEvict = vi.fn();
    const sb = createPendingSideband({ maxEntries: 2, onEvict });
    sb.add("a", new Uint8Array(10));
    sb.add("b", new Uint8Array(10));
    sb.add("c", new Uint8Array(10)); // should evict "a"
    expect(sb.size).toBe(2);
    expect(sb.has("a")).toBe(false);
    expect(sb.has("b")).toBe(true);
    expect(sb.has("c")).toBe(true);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0]?.[0]).toBe("a");
  });

  it("FIFO-evicts oldest when maxBytes cap is exceeded", () => {
    const onEvict = vi.fn();
    const sb = createPendingSideband({ maxBytes: 100, onEvict });
    sb.add("a", new Uint8Array(40));
    sb.add("b", new Uint8Array(40));
    sb.add("c", new Uint8Array(40)); // 120 total → evicts "a"
    expect(sb.size).toBe(2);
    expect(sb.totalBytes).toBe(80);
    expect(sb.has("a")).toBe(false);
    expect(onEvict).toHaveBeenCalledWith("a", expect.any(Uint8Array));
  });

  it("can evict multiple entries in one add to restore cap", () => {
    const onEvict = vi.fn();
    const sb = createPendingSideband({ maxBytes: 100, onEvict });
    sb.add("a", new Uint8Array(40));
    sb.add("b", new Uint8Array(40));
    // Single large add forces multiple FIFO evictions.
    sb.add("c", new Uint8Array(95));
    expect(sb.size).toBe(1);
    expect(sb.has("c")).toBe(true);
    expect(sb.totalBytes).toBe(95);
    expect(onEvict).toHaveBeenCalledTimes(2);
  });

  it("a too-large block evicts itself (nothing fits)", () => {
    // Edge case: block bigger than the byte cap. The
    // FIFO loop will evict everything including the
    // freshly-added entry; this is intentional — a
    // single block that won't fit the sideband can't
    // be quarantined. Caller should treat this like
    // any other eviction (terminal pending-overflow).
    const onEvict = vi.fn();
    const sb = createPendingSideband({ maxBytes: 100, onEvict });
    sb.add("big", new Uint8Array(200));
    expect(sb.size).toBe(0);
    expect(sb.totalBytes).toBe(0);
    expect(onEvict).toHaveBeenCalledWith("big", expect.any(Uint8Array));
  });

  it("caps apply jointly — first hit evicts first", () => {
    const onEvict = vi.fn();
    const sb = createPendingSideband({
      maxEntries: 5,
      maxBytes: 50,
      onEvict,
    });
    sb.add("a", new Uint8Array(20));
    sb.add("b", new Uint8Array(20));
    sb.add("c", new Uint8Array(20)); // 60 bytes → byte cap evicts "a"
    expect(sb.size).toBe(2);
    expect(sb.has("a")).toBe(false);
    expect(onEvict).toHaveBeenCalledTimes(1);
  });
});

// --- createIngestSnapshot orchestrator ---

/** Stub BlockResolver — no persistence, in-memory only. */
function stubResolver(): BlockResolver & {
  storedCount: () => number;
  hasKey: (k: string) => boolean;
} {
  const mem = new Map<string, Uint8Array>();
  return {
    async get(cid) {
      return mem.get(cid.toString()) ?? null;
    },
    has(cid) {
      return mem.has(cid.toString());
    },
    getCached(cid) {
      return mem.get(cid.toString()) ?? null;
    },
    put(cid, block) {
      mem.set(cid.toString(), block);
    },
    storedCount() {
      return mem.size;
    },
    hasKey(k) {
      return mem.has(k);
    },
  };
}

/**
 * Stub SnapshotCodec — implements only the surface
 * the orchestrator touches (applyRemote + setLastIpnsSeq
 * and the readonly fields). Records calls for
 * assertions.
 */
function stubCodec(resolver: BlockResolver): SnapshotCodec & {
  applyRemoteCalls: number;
  lastIpnsSeqSet: number | null;
} {
  const seq = 1;
  const prev: CID | null = null;
  let lastIpnsSeq: number | null = null;
  let applyRemoteCalls = 0;
  const applied = new Set<string>();
  const codec: SnapshotCodec & {
    applyRemoteCalls: number;
    lastIpnsSeqSet: number | null;
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
      // Don't actually decrypt — stubs skip the onApply
      // payload. The orchestrator passes onApply but
      // never inspects its side-effects directly.
      onApply({});
      return true;
    },
    loadVersion: vi.fn().mockResolvedValue({}),
    get prev() {
      return prev;
    },
    get seq() {
      return seq;
    },
    get lastIpnsSeq() {
      return lastIpnsSeq;
    },
    setLastIpnsSeq(s: number) {
      lastIpnsSeq = s;
      codec.lastIpnsSeqSet = s;
    },
    applyRemoteCalls: 0,
    lastIpnsSeqSet: null,
  };
  // Touch `prev`/`seq` to silence unused-variable
  // warnings from strict compiler settings.
  void prev;
  void seq;
  return codec;
}

/** Mutable chain state for orchestrator tests. */
function makeState(initialApplied: Iterable<string> = []) {
  let chain = chainWithEntries([]);
  for (const k of initialApplied) {
    chain = chainWithEntries([k]);
  }
  return {
    getState: () => ({ chain }),
    markApplied(cidStr: string) {
      const next = new Map(chain.entries);
      const existing = next.get(cidStr);
      next.set(cidStr, {
        cid: { toString: () => cidStr } as unknown as CID,
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

describe("createIngestSnapshot", () => {
  async function makeDeps() {
    const { keys, signingKey } = await generateKeys();
    const resolver = stubResolver();
    const snapshotCodec = stubCodec(resolver);
    const state = makeState();
    const outcomes: Parameters<
      NonNullable<Parameters<typeof createIngestSnapshot>[0]["onIngestOutcome"]>
    >[0][] = [];
    const api = createIngestSnapshot({
      snapshotCodec,
      resolver,
      readKey: keys.readKey,
      getClockSum: () => 42,
      getState: state.getState,
      onIngestOutcome: (r) => outcomes.push(r),
    });
    return { keys, signingKey, resolver, snapshotCodec, state, outcomes, api };
  }

  it("places a genesis-adjacent snapshot", async () => {
    const { keys, signingKey, snapshotCodec, resolver, api, outcomes } =
      await makeDeps();
    const { cid, block } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      1,
      null,
    );

    const result = await api.ingestSnapshot(cid, block, { source: "peer" });

    expect(result.outcome).toBe("placed");
    expect(snapshotCodec.applyRemoteCalls).toBe(1);
    expect(snapshotCodec.lastIpnsSeqSet).toBe(42);
    expect(resolver.hasKey(cid.toString())).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: "placed",
      source: "peer",
      fromRescan: false,
    });
  });

  it("rejects invalid-signature blocks", async () => {
    const { keys, signingKey, snapshotCodec, resolver, api, outcomes } =
      await makeDeps();
    const { block } = await encodeValidBlock(keys.readKey, signingKey, 1, null);
    // Tamper the signature region + recompute the CID
    // so CID integrity still matches — isolates the
    // signature check from the cid-integrity check.
    const tampered = new Uint8Array(block);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const hash = await sha256.digest(tampered);
    const tamperedCid = CID.createV1(DAG_CBOR, hash);

    const result = await api.ingestSnapshot(tamperedCid, tampered, {
      source: "peer",
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("invalid-signature");
    expect(snapshotCodec.applyRemoteCalls).toBe(0);
    expect(resolver.hasKey(tamperedCid.toString())).toBe(false);
    expect(outcomes[0]).toMatchObject({
      outcome: "rejected",
      reason: "invalid-signature",
    });
  });

  it("rejects cid-mismatch before touching signatures", async () => {
    const { keys, signingKey, snapshotCodec, api, outcomes } = await makeDeps();
    const { block } = await encodeValidBlock(keys.readKey, signingKey, 1, null);
    // Wrong CID for these bytes (hash a different buffer).
    const wrongHash = await sha256.digest(new Uint8Array([0x00, 0x01]));
    const wrongCid = CID.createV1(DAG_CBOR, wrongHash);

    const result = await api.ingestSnapshot(wrongCid, block, {
      source: "peer",
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("cid-mismatch");
    expect(snapshotCodec.applyRemoteCalls).toBe(0);
    expect(outcomes[0]).toMatchObject({ reason: "cid-mismatch" });
  });

  it("rejects duplicates (already applied)", async () => {
    const { keys, signingKey, snapshotCodec, state, api, outcomes } =
      await makeDeps();
    const { cid, block } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      1,
      null,
    );
    // Pre-mark as applied.
    state.markApplied(cid.toString());

    const result = await api.ingestSnapshot(cid, block, { source: "local" });

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBe("duplicate");
    expect(snapshotCodec.applyRemoteCalls).toBe(0);
    expect(outcomes[0]).toMatchObject({
      reason: "duplicate",
      source: "local",
    });
  });

  it("quarantines unplaceable snapshots and rescans", async () => {
    const { keys, signingKey, snapshotCodec, state, api, outcomes } =
      await makeDeps();
    // Parent is unknown when child arrives.
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

    const pendResult = await api.ingestSnapshot(childCid, childBlock, {
      source: "peer",
      peerId: "peer-1",
    });

    expect(pendResult.outcome).toBe("pending");
    expect(pendResult.reason).toBe("unplaceable-epoch");
    expect(snapshotCodec.applyRemoteCalls).toBe(0);
    expect(api.pendingSize).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: "pending",
      peerId: "peer-1",
      fromRescan: false,
    });

    // Parent now arrives + is applied externally —
    // simulate by placing parent through the same api.
    const parentResult = await api.ingestSnapshot(parentCid, parentBlock, {
      source: "peer",
    });
    expect(parentResult.outcome).toBe("placed");
    // Mark it applied in the chain so rescan's isPlaceable
    // + dedupe see the new linkage.
    state.markApplied(parentCid.toString());

    // Rescan — the child should now place.
    await api.rescanPending();

    expect(api.pendingSize).toBe(0);
    // Look at the rescan outcome specifically.
    const rescanRecord = outcomes.find((r) => r.fromRescan);
    expect(rescanRecord).toBeDefined();
    expect(rescanRecord?.outcome).toBe("placed");
    expect(rescanRecord?.peerId).toBe("peer-1");

    // Rescan-placed blocks skip applyRemote — the
    // interpreter rediscovers the CID in its next cycle
    // and applies via the normal tip-advance path. Only
    // the parent's first-ingest applied eagerly (1 call).
    expect(snapshotCodec.applyRemoteCalls).toBe(1);
  });

  it(
    "writes pending-path block bytes to resolver " +
      "(spec §Sideband-pending interaction with BlockResolver)",
    async () => {
      const { keys, signingKey, resolver, api } = await makeDeps();
      // An unplaceable child — parent is unknown to us.
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

      const result = await api.ingestSnapshot(childCid, childBlock, {
        source: "peer",
      });

      // Even though the block is held in sideband, its
      // bytes must be persisted to BlockResolver — other
      // peers may request this CID via catalog exchange
      // before the bridging epoch arrives locally, and a
      // later rescan should not need to refetch.
      expect(result.outcome).toBe("pending");
      expect(resolver.hasKey(childCid.toString())).toBe(true);
    },
  );

  it("emits pending-overflow when sideband FIFO-evicts", async () => {
    const { keys, signingKey } = await generateKeys();
    const resolver = stubResolver();
    const snapshotCodec = stubCodec(resolver);
    const state = makeState();
    const outcomes: Parameters<
      NonNullable<Parameters<typeof createIngestSnapshot>[0]["onIngestOutcome"]>
    >[0][] = [];
    const api = createIngestSnapshot({
      snapshotCodec,
      resolver,
      readKey: keys.readKey,
      getClockSum: () => 0,
      getState: state.getState,
      onIngestOutcome: (r) => outcomes.push(r),
      sidebandOptions: { maxEntries: 1 },
    });

    // First unplaceable child — quarantined.
    const { cid: parentA } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      1,
      null,
    );
    const { cid: childA, block: childAblock } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      2,
      parentA,
    );
    await api.ingestSnapshot(childA, childAblock, {
      source: "peer",
      peerId: "peer-A",
    });
    expect(api.pendingSize).toBe(1);

    // Second unplaceable child — forces eviction of A.
    const { cid: parentB } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      3,
      null,
    );
    const { cid: childB, block: childBblock } = await encodeValidBlock(
      keys.readKey,
      signingKey,
      4,
      parentB,
    );
    await api.ingestSnapshot(childB, childBblock, {
      source: "peer",
      peerId: "peer-B",
    });

    expect(api.pendingSize).toBe(1);
    const overflow = outcomes.find((r) => r.reason === "pending-overflow");
    expect(overflow).toBeDefined();
    expect(overflow?.outcome).toBe("rejected");
    expect(overflow?.peerId).toBe("peer-A");
  });

  it(
    "dedupes a rescan-target once applied through a " + "concurrent path",
    async () => {
      const { keys, signingKey, state, api, outcomes } = await makeDeps();
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

      // Quarantine.
      await api.ingestSnapshot(childCid, childBlock, { source: "peer" });
      expect(api.pendingSize).toBe(1);

      // Simulate the interpreter applying the child via
      // some other path (e.g., late inline-announce that
      // beat the rescan).
      state.markApplied(childCid.toString());

      // Rescan — ingestion should bail on dedupe, clear
      // the sideband, and emit rejected/duplicate with
      // fromRescan: true.
      await api.rescanPending();

      expect(api.pendingSize).toBe(0);
      const dupe = outcomes.find(
        (r) => r.fromRescan && r.reason === "duplicate",
      );
      expect(dupe).toBeDefined();
    },
  );
});
