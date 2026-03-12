import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./fetch-block.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetch-block.js")>();
  return {
    ...actual,
    fetchBlock: vi.fn(),
  };
});

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
});
