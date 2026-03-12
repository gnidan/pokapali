/**
 * Integration tests for the snapshot chain lifecycle:
 * crypto → snapshot encode → reducer chain state.
 *
 * Exercises the real cross-package data path:
 * @pokapali/crypto (key generation) →
 * @pokapali/snapshot (encode/decode) →
 * @pokapali/core facts/reducers (chain state).
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot, decodeSnapshot } from "@pokapali/snapshot";
import { initialDocState, versionHistory } from "./facts.js";
import type { Fact } from "./facts.js";
import { reduce } from "./reducers.js";

// --- Helpers ---

const DAG_CBOR_CODE = 0x71;

const IDENTITY = {
  ipnsName: "test-chain",
  role: "writer" as const,
  channels: ["content"],
  appId: "test-app",
};

async function encodeYDoc(
  ydoc: Y.Doc,
  readKey: CryptoKey,
  signingKey: Awaited<ReturnType<typeof ed25519KeyPairFromSeed>>,
  prev: CID | null,
  seq: number,
): Promise<{ cid: CID; block: Uint8Array }> {
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

// --- Tests ---

describe("snapshot chain integration", () => {
  it("real snapshot block feeds chain state " + "via reducer", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    // Create a Y.Doc and encode it as a snapshot
    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "hello");
    const { cid, block } = await encodeYDoc(
      ydoc,
      keys.readKey,
      signingKey,
      null,
      1,
    );

    // Decode to extract metadata (simulating what
    // the interpreter's decodeBlock does)
    const decoded = decodeSnapshot(block);
    expect(decoded.seq).toBe(1);
    expect(decoded.prev).toBeNull();

    // Feed through reducer as if fetched
    let state = initialDocState(IDENTITY);

    // Step 1: discover the CID
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid,
      source: "gossipsub",
    });
    expect(state.chain.entries.get(cid.toString())?.blockStatus).toBe(
      "unknown",
    );

    // Step 2: block fetched with real metadata
    state = reduce(state, {
      type: "block-fetched",
      ts: 2,
      cid,
      block,
      prev: decoded.prev ?? undefined,
      seq: decoded.seq,
    });
    expect(state.chain.entries.get(cid.toString())?.blockStatus).toBe(
      "fetched",
    );
    expect(state.chain.entries.get(cid.toString())?.seq).toBe(1);

    // Step 3: tip advanced
    state = reduce(state, {
      type: "tip-advanced",
      ts: 3,
      cid,
      seq: decoded.seq,
    });
    expect(state.chain.tip?.toString()).toBe(cid.toString());
  });

  it("multi-version chain builds correct " + "version history", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    // Version 1
    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "v1");
    const v1 = await encodeYDoc(doc1, keys.readKey, signingKey, null, 1);

    // Version 2 (prev = v1)
    const doc2 = new Y.Doc();
    doc2.getText("content").insert(0, "v2");
    const v2 = await encodeYDoc(doc2, keys.readKey, signingKey, v1.cid, 2);

    // Version 3 (prev = v2)
    const doc3 = new Y.Doc();
    doc3.getText("content").insert(0, "v3");
    const v3 = await encodeYDoc(doc3, keys.readKey, signingKey, v2.cid, 3);

    // Feed all through reducer
    let state = initialDocState(IDENTITY);
    const decoded1 = decodeSnapshot(v1.block);
    const decoded2 = decodeSnapshot(v2.block);
    const decoded3 = decodeSnapshot(v3.block);

    // Discover v3 (tip) first, as would happen
    // via gossip
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid: v3.cid,
      source: "gossipsub",
    });

    // Fetch v3 — discovers v2 via chain-walk
    state = reduce(state, {
      type: "block-fetched",
      ts: 2,
      cid: v3.cid,
      block: v3.block,
      prev: decoded3.prev ?? undefined,
      seq: decoded3.seq,
    });
    // v2 should now be discovered via chain-walk
    expect(state.chain.entries.has(v2.cid.toString())).toBe(true);
    expect(state.chain.entries.get(v2.cid.toString())?.discoveredVia).toContain(
      "chain-walk",
    );

    // Fetch v2 — discovers v1
    state = reduce(state, {
      type: "block-fetched",
      ts: 3,
      cid: v2.cid,
      block: v2.block,
      prev: decoded2.prev ?? undefined,
      seq: decoded2.seq,
    });
    expect(state.chain.entries.has(v1.cid.toString())).toBe(true);

    // Fetch v1 (no prev)
    state = reduce(state, {
      type: "block-fetched",
      ts: 4,
      cid: v1.cid,
      block: v1.block,
      prev: decoded1.prev ?? undefined,
      seq: decoded1.seq,
    });

    // Advance tip to v3
    state = reduce(state, {
      type: "tip-advanced",
      ts: 5,
      cid: v3.cid,
      seq: decoded3.seq,
    });

    // Version history should list all 3 in
    // descending seq order
    const history = versionHistory(state.chain);
    expect(history).toHaveLength(3);
    expect(history[0].seq).toBe(3);
    expect(history[1].seq).toBe(2);
    expect(history[2].seq).toBe(1);
    expect(history[0].cid.toString()).toBe(v3.cid.toString());
    expect(history[2].cid.toString()).toBe(v1.cid.toString());
    // v3 is applied, v1 and v2 are fetched
    expect(history[0].available).toBe(true);
    expect(history[1].available).toBe(true);
    expect(history[2].available).toBe(true);
  });

  it("real block metadata matches reducer " + "chain entry", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "first");
    const v1 = await encodeYDoc(doc1, keys.readKey, signingKey, null, 1);

    const doc2 = new Y.Doc();
    doc2.getText("content").insert(0, "second");
    const v2 = await encodeYDoc(doc2, keys.readKey, signingKey, v1.cid, 2);

    const decoded2 = decodeSnapshot(v2.block);

    // Verify snapshot metadata matches what we
    // passed in
    expect(decoded2.seq).toBe(2);
    expect(decoded2.prev?.toString()).toBe(v1.cid.toString());

    // Feed through reducer and verify chain entry
    // matches snapshot metadata
    let state = initialDocState(IDENTITY);
    state = reduce(state, {
      type: "cid-discovered",
      ts: 1,
      cid: v2.cid,
      source: "ipns",
    });
    state = reduce(state, {
      type: "block-fetched",
      ts: 2,
      cid: v2.cid,
      block: v2.block,
      prev: decoded2.prev ?? undefined,
      seq: decoded2.seq,
    });

    const entry = state.chain.entries.get(v2.cid.toString());
    expect(entry).toBeDefined();
    expect(entry!.seq).toBe(decoded2.seq);
    expect(entry!.prev?.toString()).toBe(decoded2.prev?.toString());
    expect(entry!.blockStatus).toBe("fetched");
  });

  it("ack and guarantee facts accumulate on " + "chain entries", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "test");
    const { cid, block } = await encodeYDoc(
      ydoc,
      keys.readKey,
      signingKey,
      null,
      1,
    );
    const decoded = decodeSnapshot(block);

    let state = initialDocState(IDENTITY);

    // Discover, fetch, apply
    const facts: Fact[] = [
      {
        type: "cid-discovered",
        ts: 1,
        cid,
        source: "gossipsub",
      },
      {
        type: "block-fetched",
        ts: 2,
        cid,
        block,
        seq: decoded.seq,
      },
      {
        type: "tip-advanced",
        ts: 3,
        cid,
        seq: decoded.seq,
      },
      {
        type: "ack-received",
        ts: 4,
        cid,
        peerId: "pinner-a",
      },
      {
        type: "ack-received",
        ts: 5,
        cid,
        peerId: "pinner-b",
      },
      {
        type: "guarantee-received",
        ts: 6,
        cid,
        peerId: "pinner-a",
        guaranteeUntil: 1000,
        retainUntil: 2000,
      },
    ];

    for (const fact of facts) {
      state = reduce(state, fact);
    }

    const entry = state.chain.entries.get(cid.toString());
    expect(entry!.ackedBy).toEqual(new Set(["pinner-a", "pinner-b"]));
    expect(entry!.guarantees.get("pinner-a")).toEqual({
      guaranteeUntil: 1000,
      retainUntil: 2000,
    });
    expect(state.chain.tip?.toString()).toBe(cid.toString());
  });

  it("derived status transitions through " + "full lifecycle", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "status");
    const { cid, block } = await encodeYDoc(
      ydoc,
      keys.readKey,
      signingKey,
      null,
      1,
    );
    const decoded = decodeSnapshot(block);

    let state = initialDocState(IDENTITY);

    // Initial: offline, unpublished
    expect(state.status).toBe("offline");
    expect(state.saveState).toBe("unpublished");

    // Gossip subscription → connecting
    state = reduce(state, {
      type: "gossip-subscribed",
      ts: 1,
    });
    expect(state.status).toBe("connecting");

    // Content dirty → dirty
    state = reduce(state, {
      type: "content-dirty",
      ts: 2,
      clockSum: 1,
    });
    expect(state.saveState).toBe("dirty");

    // Publish started → saving
    state = reduce(state, {
      type: "publish-started",
      ts: 3,
    });
    expect(state.saveState).toBe("saving");

    // Publish succeeded → saved (after tip)
    state = reduce(state, {
      type: "cid-discovered",
      ts: 4,
      cid,
      source: "gossipsub",
      block,
      seq: decoded.seq,
    });
    state = reduce(state, {
      type: "tip-advanced",
      ts: 5,
      cid,
      seq: decoded.seq,
    });
    state = reduce(state, {
      type: "publish-succeeded",
      ts: 6,
      cid,
      seq: decoded.seq,
    });
    expect(state.saveState).toBe("saved");
  });
});
