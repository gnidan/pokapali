import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./fetch-block.js", () => ({
  fetchBlock: vi.fn(),
}));

import { createSnapshotLifecycle } from "./snapshot-lifecycle.js";
import { fetchBlock } from "./fetch-block.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSnapshot as realEncodeSnapshot } from "@pokapali/snapshot";
import { ed25519KeyPairFromSeed } from "@pokapali/crypto";

describe("createSnapshotLifecycle", () => {
  const mockHelia = {
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("Not found")),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("push increments seq and tracks prev", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const plaintext = {
      content: new Uint8Array([1]),
    };
    const result1 = await lc.push(plaintext, readKey, signingKey, 10);
    expect(result1.seq).toBe(1);
    expect(result1.prev).toBeNull();

    const result2 = await lc.push(plaintext, readKey, signingKey, 20);
    expect(result2.seq).toBe(2);
    expect(result2.prev).not.toBeNull();
  });

  it("history returns empty before push", async () => {
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });
    const h = await lc.history();
    expect(h).toEqual([]);
  });

  it("applyRemote updates seq/prev when remote " + "is newer", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    // Simulate a remote snapshot at seq=5
    const plaintext = {
      content: new Uint8Array([1]),
    };
    const remoteSigningKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
    const block = await realEncodeSnapshot(
      plaintext,
      readKey,
      null,
      5,
      Date.now(),
      remoteSigningKey,
    );

    const hash = await sha256.digest(block);
    const cid = CID.createV1(0x71, hash);

    vi.mocked(fetchBlock).mockResolvedValue(block);

    const applied: Record<string, Uint8Array>[] = [];
    const result = await lc.applyRemote(cid, readKey, (snap) => {
      applied.push(snap);
    });

    expect(result).toBe(true);
    expect(applied).toHaveLength(1);
  });

  it("applyRemote skips already-applied CID", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const plaintext = {
      content: new Uint8Array([1]),
    };
    const { cid } = await lc.push(plaintext, readKey, signingKey, 10);

    // Applying the same CID should be a no-op
    const result = await lc.applyRemote(cid, readKey, () => {});
    expect(result).toBe(false);
  });

  it("history walks a multi-entry prev chain", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const p1 = { content: new Uint8Array([1]) };
    const r1 = await lc.push(p1, readKey, signingKey, 10);

    const p2 = { content: new Uint8Array([2]) };
    const r2 = await lc.push(p2, readKey, signingKey, 20);

    const p3 = { content: new Uint8Array([3]) };
    const r3 = await lc.push(p3, readKey, signingKey, 30);

    const entries = await lc.history();

    expect(entries).toHaveLength(3);

    // Most recent first (tip → oldest)
    expect(entries[0].seq).toBe(3);
    expect(entries[0].cid.toString()).toBe(r3.cid.toString());

    expect(entries[1].seq).toBe(2);
    expect(entries[1].cid.toString()).toBe(r2.cid.toString());

    expect(entries[2].seq).toBe(1);
    expect(entries[2].cid.toString()).toBe(r1.cid.toString());

    // Timestamps are reasonable
    for (const entry of entries) {
      expect(entry.ts).toBeGreaterThan(0);
    }
  });

  it("passes httpUrls to fetchBlock" + " during applyRemote", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const urls = ["https://relay1.example.com", "https://relay2.example.com"];
    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
      httpUrls: () => urls,
    });

    // Create a valid snapshot to apply
    const plaintext = {
      content: new Uint8Array([42]),
    };
    const block = await realEncodeSnapshot(
      plaintext,
      readKey,
      null,
      1,
      Date.now(),
      signingKey,
    );
    const hash = await sha256.digest(block);
    const cid = CID.createV1(0x71, hash);

    vi.mocked(fetchBlock).mockResolvedValue(block);

    await lc.applyRemote(cid, readKey, () => {});

    expect(fetchBlock).toHaveBeenCalledWith(expect.anything(), cid, {
      httpUrls: urls,
    });
  });

  it(
    "history returns partial chain when " + "predecessor blocks are missing",
    async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

      // Build a 3-block chain externally
      const p = { content: new Uint8Array([1]) };
      const block1 = await realEncodeSnapshot(
        p,
        readKey,
        null,
        1,
        1000,
        signingKey,
      );
      const hash1 = await sha256.digest(block1);
      const cid1 = CID.createV1(0x71, hash1);

      const block2 = await realEncodeSnapshot(
        p,
        readKey,
        cid1,
        2,
        2000,
        signingKey,
      );
      const hash2 = await sha256.digest(block2);
      const cid2 = CID.createV1(0x71, hash2);

      const block3 = await realEncodeSnapshot(
        p,
        readKey,
        cid2,
        3,
        3000,
        signingKey,
      );
      const hash3 = await sha256.digest(block3);
      const cid3 = CID.createV1(0x71, hash3);

      // Simulate open() path: applyRemote with only
      // the tip block — predecessors not in memory
      // or blockstore.
      vi.mocked(fetchBlock).mockResolvedValue(block3);

      const lc = createSnapshotLifecycle({
        getHelia: () => mockHelia as any,
      });

      await lc.applyRemote(cid3, readKey, () => {});

      // history() should return the tip entry and
      // gracefully stop (not throw) when it can't
      // find cid2.
      const entries = await lc.history();
      expect(entries).toHaveLength(1);
      expect(entries[0].seq).toBe(3);
      expect(entries[0].cid.toString()).toBe(cid3.toString());
    },
  );

  it(
    "history uses blockstore fallback for " + "predecessor blocks",
    async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

      // Build a 2-block chain
      const p = { content: new Uint8Array([1]) };
      const block1 = await realEncodeSnapshot(
        p,
        readKey,
        null,
        1,
        1000,
        signingKey,
      );
      const hash1 = await sha256.digest(block1);
      const cid1 = CID.createV1(0x71, hash1);

      const block2 = await realEncodeSnapshot(
        p,
        readKey,
        cid1,
        2,
        2000,
        signingKey,
      );
      const hash2 = await sha256.digest(block2);
      const cid2 = CID.createV1(0x71, hash2);

      // Blockstore has block1 (predecessor)
      const heliaWithBlocks = {
        blockstore: {
          put: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockImplementation(async (cid: CID) => {
            if (cid.equals(cid1)) return block1;
            throw new Error("Not found");
          }),
        },
      };

      vi.mocked(fetchBlock).mockResolvedValue(block2);

      const lc = createSnapshotLifecycle({
        getHelia: () => heliaWithBlocks as any,
      });

      // Apply only the tip
      await lc.applyRemote(cid2, readKey, () => {});

      // history() should find block2 in-memory, then
      // fetch block1 from blockstore
      const entries = await lc.history();
      expect(entries).toHaveLength(2);
      expect(entries[0].seq).toBe(2);
      expect(entries[1].seq).toBe(1);
    },
  );

  it("history returns single entry after one push", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const lc = createSnapshotLifecycle({
      getHelia: () => mockHelia as any,
    });

    const p1 = { content: new Uint8Array([1]) };
    const r1 = await lc.push(p1, readKey, signingKey, 10);

    const entries = await lc.history();
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].cid.toString()).toBe(r1.cid.toString());
  });
});
