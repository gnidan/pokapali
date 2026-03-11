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

async function fakeCid(seed: number): Promise<CID> {
  const hash = await sha256.digest(new Uint8Array([seed]));
  return CID.createV1(0x71, hash);
}

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
