import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSnapshot as realEncodeSnapshot } from "@pokapali/snapshot";
import { ed25519KeyPairFromSeed } from "@pokapali/crypto";

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

describe("createSnapshotCodec", () => {
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
    const resolver = createMockResolver();

    const lc = createSnapshotCodec({ resolver });

    const plaintext = {
      content: new Uint8Array([1]),
    };
    const result1 = await lc.push(plaintext, readKey, signingKey, 10);
    expect(result1.seq).toBe(1);
    expect(result1.prev).toBeNull();
    expect(resolver.put).toHaveBeenCalled();

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
    const remoteSigningKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

    const plaintext = {
      content: new Uint8Array([1]),
    };
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

    // Pre-populate the resolver with the block
    const blocks = new Map<string, Uint8Array>();
    blocks.set(cid.toString(), block);
    const resolver = createMockResolver(blocks);

    const lc = createSnapshotCodec({ resolver });

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
    const resolver = createMockResolver();

    const lc = createSnapshotCodec({ resolver });

    const plaintext = {
      content: new Uint8Array([1]),
    };
    const { cid } = await lc.push(plaintext, readKey, signingKey, 10);

    // Applying the same CID should be a no-op
    const result = await lc.applyRemote(cid, readKey, () => {});
    expect(result).toBe(false);
  });

  it("applyRemote uses resolver.get() for blocks", async () => {
    const readKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));

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

    const blocks = new Map<string, Uint8Array>();
    blocks.set(cid.toString(), block);
    const resolver = createMockResolver(blocks);

    const lc = createSnapshotCodec({ resolver });

    await lc.applyRemote(cid, readKey, () => {});

    expect(resolver.get).toHaveBeenCalledWith(cid);
  });
});
