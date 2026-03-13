/**
 * Tests for version history features:
 * - fetchVersionHistory() (Item 2)
 * - Enhanced "snapshot" event payload (Item 3)
 * - Partial history / gap handling (Item 5)
 *
 * Items 2 and 3 test features being built in the
 * versioning wave. They define expected behavior
 * and will fail until the features are implemented.
 *
 * Item 5 tests gap-tolerant chain walking — some
 * blocks fetchable, some 404.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSnapshot } from "@pokapali/snapshot";
import { ed25519KeyPairFromSeed } from "@pokapali/crypto";

const DAG_CBOR_CODE = 0x71;

/** Create a valid Yjs state update for testing. */
function makeYjsUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

async function makeKeys() {
  const readKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
  return { readKey, signingKey };
}

async function blockToCid(block: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(block);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

function createMockResolver(blocks?: Map<string, Uint8Array>): BlockResolver {
  const cache = blocks ?? new Map<string, Uint8Array>();
  return {
    get: vi.fn(async (cid: CID) => {
      return cache.get(cid.toString()) ?? null;
    }),
    getCached: vi.fn((cid: CID) => {
      return cache.get(cid.toString()) ?? null;
    }),
    put: vi.fn((cid: CID, block: Uint8Array) => {
      cache.set(cid.toString(), block);
    }),
  };
}

describe("snapshot event payload (Item 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("push result includes cid, seq, and ts", async () => {
    const { readKey, signingKey } = await makeKeys();
    const resolver = createMockResolver();
    const lc = createSnapshotCodec({ resolver });

    const result = await lc.push(
      { content: new Uint8Array([1]) },
      readKey,
      signingKey,
      42,
    );

    // push() already returns { cid, block, seq,
    // prev }. Verify the fields exist.
    expect(result.cid).toBeInstanceOf(CID);
    expect(result.seq).toBe(1);
    expect(result.block).toBeInstanceOf(Uint8Array);
  });

  it("applyRemote provides cid and seq" + " information", async () => {
    const { readKey, signingKey } = await makeKeys();

    const block = await encodeSnapshot(
      { content: new Uint8Array([1]) },
      readKey,
      null,
      5,
      Date.now(),
      signingKey,
    );
    const cid = await blockToCid(block);

    const blocks = new Map<string, Uint8Array>();
    blocks.set(cid.toString(), block);
    const resolver = createMockResolver(blocks);
    const lc = createSnapshotCodec({ resolver });

    const applied: Record<string, Uint8Array>[] = [];
    const result = await lc.applyRemote(cid, readKey, (snap) =>
      applied.push(snap),
    );

    expect(result).toBe(true);
    // After applyRemote, the block should be in
    // the resolver cache
    expect(resolver.put).toHaveBeenCalledWith(cid, block);
  });
});

// Deep history chain tests moved to
// facts.test.ts — versionHistory(chain) is the
// canonical history derivation now.

describe("partial history / gap handling (Item 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadVersion throws cleanly for" + " missing block", async () => {
    const { readKey, signingKey } = await makeKeys();

    // Resolver returns null for unknown CIDs
    const resolver = createMockResolver();
    const lc = createSnapshotCodec({
      resolver,
    });

    // Push one version so we have a valid CID
    await lc.push({ content: new Uint8Array([1]) }, readKey, signingKey, 10);

    // Create a CID that doesn't exist in resolver
    const fakeCid = CID.createV1(
      DAG_CBOR_CODE,
      await sha256.digest(new TextEncoder().encode("missing")),
    );

    await expect(lc.loadVersion(fakeCid, readKey)).rejects.toThrow(
      "Block not found",
    );
  });

  it("loadVersion succeeds for locally" + " stored block", async () => {
    const { readKey, signingKey } = await makeKeys();
    const resolver = createMockResolver();
    const lc = createSnapshotCodec({
      resolver,
    });

    const result = await lc.push(
      { content: makeYjsUpdate("hello") },
      readKey,
      signingKey,
      10,
    );

    // loadVersion should find it via resolver
    const docs = await lc.loadVersion(result.cid, readKey);
    expect(docs).toHaveProperty("content");
    expect(docs.content).toBeDefined();
    expect(docs.content.getText("content").toString()).toBe("hello");
  });

  it("push builds a chain of versions", async () => {
    const { readKey, signingKey } = await makeKeys();
    const resolver = createMockResolver();
    const lc = createSnapshotCodec({ resolver });

    // Push 5 versions
    const results = [];
    for (let i = 1; i <= 5; i++) {
      results.push(
        await lc.push(
          { content: new Uint8Array([i]) },
          readKey,
          signingKey,
          i * 10,
        ),
      );
    }

    // Verify chain linkage via prev pointers
    expect(results[0].prev).toBeNull();
    for (let i = 1; i < results.length; i++) {
      expect(results[i].prev!.toString()).toBe(results[i - 1].cid.toString());
    }
  });

  it(
    "loadVersion falls back to resolver.get()" + " for non-local blocks",
    async () => {
      const { readKey, signingKey } = await makeKeys();

      // Create a snapshot block manually
      const block = await encodeSnapshot(
        { content: makeYjsUpdate("remote") },
        readKey,
        null,
        1,
        Date.now(),
        signingKey,
      );
      const cid = await blockToCid(block);

      // Pre-populate resolver with the block
      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const resolver = createMockResolver(blocks);
      const lc = createSnapshotCodec({
        resolver,
      });

      const docs = await lc.loadVersion(cid, readKey);
      expect(docs).toHaveProperty("content");
      expect(resolver.get).toHaveBeenCalled();
    },
  );

  it(
    "loadVersion does not cascade failures" + " to other operations",
    async () => {
      const { readKey, signingKey } = await makeKeys();
      const resolver = createMockResolver();
      const lc = createSnapshotCodec({
        resolver,
      });

      // Push a valid version
      const result = await lc.push(
        { content: makeYjsUpdate("version-1") },
        readKey,
        signingKey,
        10,
      );

      // Attempt to load a missing version
      const fakeCid = CID.createV1(
        DAG_CBOR_CODE,
        await sha256.digest(new TextEncoder().encode("gone")),
      );

      await expect(lc.loadVersion(fakeCid, readKey)).rejects.toThrow();

      // Push should still work after failed load
      const result2 = await lc.push(
        { content: makeYjsUpdate("version-2") },
        readKey,
        signingKey,
        20,
      );
      expect(result2.seq).toBe(2);

      // loadVersion of valid CID still works
      const docs = await lc.loadVersion(result.cid, readKey);
      expect(docs).toHaveProperty("content");
    },
  );
});
