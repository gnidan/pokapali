import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { createSnapshotCodec } from "./snapshot-codec.js";
import type { BlockResolver } from "./block-resolver.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  encodeSnapshot as realEncodeSnapshot,
  decodeSnapshot as realDecodeSnapshot,
} from "@pokapali/blocks";
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

  describe("encode/decode round-trip", () => {
    it("push then applyRemote recovers plaintext", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const plaintext = {
        content: new Uint8Array([10, 20, 30]),
        meta: new Uint8Array([40, 50]),
      };
      const { cid } = await codec.push(plaintext, readKey, signingKey, 1);

      // New codec instance applies the remote block
      const codec2 = createSnapshotCodec({ resolver });
      const recovered: Record<string, Uint8Array>[] = [];
      await codec2.applyRemote(cid, readKey, (snap) => {
        recovered.push(snap);
      });

      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.content).toEqual(plaintext.content);
      expect(recovered[0]!.meta).toEqual(plaintext.meta);
    });

    it("push produces valid block decodable by snapshot package", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      await codec.push(
        { content: new Uint8Array([1]) },
        readKey,
        signingKey,
        1,
      );
      const { cid } = await codec.push(
        { content: new Uint8Array([2]) },
        readKey,
        signingKey,
        2,
      );

      // Decode using the snapshot package directly
      const block = resolver.getCached(cid)!;
      expect(block).toBeTruthy();
      const node = realDecodeSnapshot(block);
      expect(node.seq).toBe(2);
      expect(node.prev).not.toBeNull();
    });
  });

  describe("chain tip tracking", () => {
    it("prev links form a chain", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const r1 = await codec.push(
        { c: new Uint8Array([1]) },
        readKey,
        signingKey,
        1,
      );
      const r2 = await codec.push(
        { c: new Uint8Array([2]) },
        readKey,
        signingKey,
        2,
      );
      const r3 = await codec.push(
        { c: new Uint8Array([3]) },
        readKey,
        signingKey,
        3,
      );

      expect(r1.prev).toBeNull();
      expect(r1.seq).toBe(1);
      expect(r2.prev!.equals(r1.cid)).toBe(true);
      expect(r2.seq).toBe(2);
      expect(r3.prev!.equals(r2.cid)).toBe(true);
      expect(r3.seq).toBe(3);

      // Codec state reflects latest
      expect(codec.prev!.equals(r3.cid)).toBe(true);
      expect(codec.seq).toBe(4);
    });

    it("applyRemote advances seq when remote is ahead", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));

      // Encode a block at seq 10 externally
      const block = await realEncodeSnapshot(
        { c: new Uint8Array([1]) },
        readKey,
        null,
        10,
        Date.now(),
        key,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(0x71, hash);

      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const resolver = createMockResolver(blocks);
      const codec = createSnapshotCodec({ resolver });

      // Codec starts at seq 1
      expect(codec.seq).toBe(1);

      await codec.applyRemote(cid, readKey, () => {});

      // seq should jump past remote's seq
      expect(codec.seq).toBe(11);
      expect(codec.prev!.equals(cid)).toBe(true);
    });

    it("applyRemote does not regress seq for older remote", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      // Push 3 local snapshots → seq is now 4
      for (let i = 0; i < 3; i++) {
        await codec.push({ c: new Uint8Array([i]) }, readKey, key, i);
      }
      expect(codec.seq).toBe(4);

      // Apply a remote with seq 1 (older)
      const block = await realEncodeSnapshot(
        { c: new Uint8Array([99]) },
        readKey,
        null,
        1,
        Date.now(),
        key,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(0x71, hash);
      resolver.put(cid, block);

      await codec.applyRemote(cid, readKey, () => {});

      // seq should NOT regress
      expect(codec.seq).toBe(4);
    });
  });

  describe("lastIpnsSeq", () => {
    it("starts null", () => {
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });
      expect(codec.lastIpnsSeq).toBeNull();
    });

    it("setLastIpnsSeq updates value", () => {
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });
      codec.setLastIpnsSeq(42);
      expect(codec.lastIpnsSeq).toBe(42);
    });

    it("push sets lastIpnsSeq to clockSum", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      await codec.push({ c: new Uint8Array([1]) }, readKey, key, 77);
      expect(codec.lastIpnsSeq).toBe(77);
    });
  });

  describe("loadVersion", () => {
    it("decodes block into Y.Docs per channel", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      // Create a Y.Doc with some content
      const doc = new Y.Doc();
      doc.getText("body").insert(0, "hello world");
      const update = Y.encodeStateAsUpdate(doc);

      const { cid } = await codec.push({ content: update }, readKey, key, 1);

      const result = await codec.loadVersion(cid, readKey);
      expect(result.content).toBeInstanceOf(Y.Doc);
      expect(result.content!.getText("body").toString()).toBe("hello world");
    });

    it("caches decoded versions", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const doc = new Y.Doc();
      doc.getText("t").insert(0, "cached");
      const update = Y.encodeStateAsUpdate(doc);

      const { cid } = await codec.push({ c: update }, readKey, key, 1);

      const first = await codec.loadVersion(cid, readKey);
      const second = await codec.loadVersion(cid, readKey);
      // Same object reference — served from cache
      expect(first).toBe(second);
    });

    it("throws for missing block", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const hash = await sha256.digest(new Uint8Array([99]));
      const fakeCid = CID.createV1(0x71, hash);

      await expect(codec.loadVersion(fakeCid, readKey)).rejects.toThrow(
        "Block not found",
      );
    });
  });

  describe("error cases", () => {
    it("applyRemote returns false for missing block", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const hash = await sha256.digest(new Uint8Array([88]));
      const fakeCid = CID.createV1(0x71, hash);

      const result = await codec.applyRemote(fakeCid, readKey, () => {});
      expect(result).toBe(false);
    });

    it("applyRemote throws with wrong decryption key", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const wrongKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));

      const block = await realEncodeSnapshot(
        { c: new Uint8Array([1]) },
        readKey,
        null,
        1,
        Date.now(),
        key,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(0x71, hash);

      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid.toString(), block);
      const resolver = createMockResolver(blocks);
      const codec = createSnapshotCodec({ resolver });

      await expect(
        codec.applyRemote(cid, wrongKey, () => {}),
      ).rejects.toThrow();
    });

    it("loadVersion throws with wrong decryption key", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const wrongKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const key = await ed25519KeyPairFromSeed(new Uint8Array(32));

      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const { cid } = await codec.push(
        { c: new Uint8Array([1]) },
        readKey,
        key,
        1,
      );

      await expect(codec.loadVersion(cid, wrongKey)).rejects.toThrow();
    });

    it("applyRemote returns false for empty block", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const hash = await sha256.digest(new Uint8Array(0));
      const fakeCid = CID.createV1(0x71, hash);

      // Resolver returns empty block
      (resolver.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Uint8Array(0),
      );

      const result = await codec.applyRemote(fakeCid, readKey, () => {});
      expect(result).toBe(false);
    });
  });

  describe("identity key", () => {
    it("push with identityKey includes publisher", async () => {
      const readKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const signingKey = await ed25519KeyPairFromSeed(new Uint8Array(32));
      const identityKey = await ed25519KeyPairFromSeed(
        new Uint8Array(32).fill(1),
      );
      const resolver = createMockResolver();
      const codec = createSnapshotCodec({ resolver });

      const { cid } = await codec.push(
        { c: new Uint8Array([1]) },
        readKey,
        signingKey,
        1,
        identityKey,
      );

      const block = resolver.getCached(cid)!;
      const node = realDecodeSnapshot(block);
      expect(node.publisher).toBeTruthy();
      expect(node.publisherSig).toBeTruthy();
    });
  });
});
