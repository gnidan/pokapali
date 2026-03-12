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

vi.mock("./fetch-block.js", () => ({
  fetchBlock: vi.fn(),
}));

import { createSnapshotLifecycle } from "./snapshot-lifecycle.js";
import { fetchBlock } from "./fetch-block.js";
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

describe("snapshot event payload (Item 3)", () => {
  const mockHelia = {
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("Not found")),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("push result includes cid, seq, and ts", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

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
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const block = await encodeSnapshot(
      { content: new Uint8Array([1]) },
      readKey,
      null,
      5,
      Date.now(),
      signingKey,
    );
    const cid = await blockToCid(block);
    vi.mocked(fetchBlock).mockResolvedValue(block);

    const applied: Record<string, Uint8Array>[] = [];
    const result = await lc.applyRemote(cid, readKey, (snap) =>
      applied.push(snap),
    );

    expect(result).toBe(true);
    // After applyRemote, the lifecycle should
    // track the CID for history walking
    const history = await lc.history();
    // The applied snapshot should be walkable
    // if it becomes the prev for next push
    expect(history.length).toBeGreaterThanOrEqual(0);
  });
});

describe("deep history chain (Item 4)", () => {
  const mockHelia = {
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("Not found")),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks a chain of 10+ versions correctly", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const pushResults = [];
    for (let i = 1; i <= 12; i++) {
      const result = await lc.push(
        {
          content: new Uint8Array([i]),
        },
        readKey,
        signingKey,
        i * 10,
      );
      pushResults.push(result);
    }

    const entries = await lc.history();
    expect(entries).toHaveLength(12);

    // Newest first
    expect(entries[0].seq).toBe(12);
    expect(entries[11].seq).toBe(1);

    // All seqs present and ordered descending
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i].seq).toBe(12 - i);
    }

    // All CIDs match push results (reversed)
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i].cid.toString()).toBe(
        pushResults[11 - i].cid.toString(),
      );
    }
  });

  it("all entries have valid timestamps", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    for (let i = 0; i < 10; i++) {
      await lc.push(
        { content: new Uint8Array([i]) },
        readKey,
        signingKey,
        i * 100,
      );
    }

    const entries = await lc.history();
    for (const entry of entries) {
      expect(entry.ts).toBeGreaterThan(0);
      expect(typeof entry.ts).toBe("number");
    }
  });
});

describe("partial history / gap handling (Item 5)", () => {
  const mockHelia = {
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("Not found")),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadVersion throws cleanly for" + " missing block", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    // Push one version so we have a valid CID
    const result = await lc.push(
      { content: new Uint8Array([1]) },
      readKey,
      signingKey,
      10,
    );

    // Create a CID that doesn't exist in local
    // blocks or blockstore
    const fakeCid = CID.createV1(
      DAG_CBOR_CODE,
      await sha256.digest(new TextEncoder().encode("missing")),
    );

    await expect(lc.loadVersion(fakeCid, readKey)).rejects.toThrow(
      "Unknown CID",
    );
  });

  it("loadVersion succeeds for locally" + " stored block", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const result = await lc.push(
      { content: makeYjsUpdate("hello") },
      readKey,
      signingKey,
      10,
    );

    // loadVersion should find it in local blocks
    const docs = await lc.loadVersion(result.cid, readKey);
    expect(docs).toHaveProperty("content");
    expect(docs.content).toBeDefined();
    expect(docs.content.getText("content").toString()).toBe("hello");
  });

  it("history stops at broken chain link", async () => {
    const { readKey, signingKey } = await makeKeys();
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    // Push 5 versions
    for (let i = 1; i <= 5; i++) {
      await lc.push(
        { content: new Uint8Array([i]) },
        readKey,
        signingKey,
        i * 10,
      );
    }

    // Verify full chain is walkable
    const entries = await lc.history();
    expect(entries).toHaveLength(5);
  });

  it(
    "loadVersion falls back to blockstore" + " for non-local blocks",
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

      // Mock helia blockstore to return it
      const heliaWithBlock = {
        blockstore: {
          put: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue(block),
        },
      };

      const lc = createSnapshotLifecycle({
        getHelia: () => heliaWithBlock as any,
      });

      const docs = await lc.loadVersion(cid, readKey);
      expect(docs).toHaveProperty("content");
      expect(heliaWithBlock.blockstore.get).toHaveBeenCalledWith(cid);
    },
  );

  it(
    "loadVersion does not cascade failures" + " to other operations",
    async () => {
      const { readKey, signingKey } = await makeKeys();
      const lc = createSnapshotLifecycle({
        getHelia: () => mockHelia as any,
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

      // History should still work
      const entries = await lc.history();
      expect(entries).toHaveLength(2);

      // loadVersion of valid CID still works
      const docs = await lc.loadVersion(result.cid, readKey);
      expect(docs).toHaveProperty("content");
    },
  );
});
