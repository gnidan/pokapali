import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import {
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  generateIdentityKeypair,
  signBytes,
  verifySignature,
} from "@pokapali/crypto";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  validateStructure,
  walkChain,
  createFetchCoalescerState,
  coalescerNext,
  coalescerResolve,
  coalescerFail,
} from "./index.js";

async function makeTestKeys() {
  const keys = await deriveDocKeys("test-secret", "test-app", ["doc"]);
  const seed = keys.ipnsKeyBytes;
  const signingKey = await ed25519KeyPairFromSeed(seed);
  return { readKey: keys.readKey, signingKey };
}

async function cidFromBytes(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, hash);
}

describe("@pokapali/snapshot", () => {
  describe("encodeSnapshot / decodeSnapshot", () => {
    it("round-trips CBOR encoding", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const subdocs = {
        doc: new Uint8Array([1, 2, 3]),
      };

      const encoded = await encodeSnapshot(
        subdocs,
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      expect(encoded).toBeInstanceOf(Uint8Array);

      const node = decodeSnapshot(encoded);
      expect(node.seq).toBe(0);
      expect(node.ts).toBe(1000);
      expect(node.prev).toBeNull();
      expect(node.publicKey).toEqual(signingKey.publicKey);
      expect(node.signature).toBeInstanceOf(Uint8Array);
      expect(node.subdocs.doc).toBeInstanceOf(Uint8Array);
    });
  });

  describe("decryptSnapshot", () => {
    it("decrypts subdoc payloads", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const plaintext = {
        doc: new Uint8Array([10, 20, 30]),
        meta: new Uint8Array([40, 50]),
      };

      const encoded = await encodeSnapshot(
        plaintext,
        readKey,
        null,
        1,
        2000,
        signingKey,
      );
      const node = decodeSnapshot(encoded);
      const decrypted = await decryptSnapshot(node, readKey);

      expect(decrypted.doc).toEqual(plaintext.doc);
      expect(decrypted.meta).toEqual(plaintext.meta);
    });
  });

  describe("wrong readKey", () => {
    it("decrypt fails with wrong key", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1, 2, 3]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      const node = decodeSnapshot(encoded);

      // Derive a different readKey
      const otherKeys = await deriveDocKeys("other-secret", "other-app", [
        "doc",
      ]);
      await expect(decryptSnapshot(node, otherKeys.readKey)).rejects.toThrow();
    });
  });

  describe("validateStructure", () => {
    it("returns true for valid snapshot", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      expect(await validateStructure(encoded)).toBe(true);
    });

    it("returns false for tampered data", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );

      // Tamper with the encoded bytes
      const tampered = new Uint8Array(encoded);
      tampered[tampered.length - 2] ^= 0xff;

      expect(await validateStructure(tampered)).toBe(false);
    });

    it("returns false for garbage bytes", async () => {
      expect(await validateStructure(new Uint8Array([0, 1, 2, 3]))).toBe(false);
    });
  });

  describe("walkChain", () => {
    it("walks from tip to genesis", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const blocks = new Map<string, Uint8Array>();

      // Genesis (no prev)
      const genesis = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      const genesisCid = await cidFromBytes(genesis);
      blocks.set(genesisCid.toString(), genesis);

      // Second block
      const second = await encodeSnapshot(
        { doc: new Uint8Array([2]) },
        readKey,
        genesisCid,
        1,
        2000,
        signingKey,
      );
      const secondCid = await cidFromBytes(second);
      blocks.set(secondCid.toString(), second);

      // Third block
      const third = await encodeSnapshot(
        { doc: new Uint8Array([3]) },
        readKey,
        secondCid,
        2,
        3000,
        signingKey,
      );
      const thirdCid = await cidFromBytes(third);
      blocks.set(thirdCid.toString(), third);

      const getter = async (cid: CID) => {
        const block = blocks.get(cid.toString());
        if (!block) {
          throw new Error(`block not found: ${cid}`);
        }
        return block;
      };

      const nodes: Array<{
        seq: number;
        ts: number;
      }> = [];
      for await (const node of walkChain(thirdCid, getter)) {
        nodes.push({
          seq: node.seq,
          ts: node.ts,
        });
      }

      expect(nodes).toEqual([
        { seq: 2, ts: 3000 },
        { seq: 1, ts: 2000 },
        { seq: 0, ts: 1000 },
      ]);
    });

    it("yields single node for genesis", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const genesis = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      const cid = await cidFromBytes(genesis);

      const getter = async () => genesis;
      const nodes: number[] = [];
      for await (const node of walkChain(cid, getter)) {
        nodes.push(node.seq);
      }
      expect(nodes).toEqual([0]);
    });
  });

  describe("encodeSnapshot with prev CID", () => {
    it("stores prev CID in node", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const genesis = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      const prevCid = await cidFromBytes(genesis);

      const second = await encodeSnapshot(
        { doc: new Uint8Array([2]) },
        readKey,
        prevCid,
        1,
        2000,
        signingKey,
      );
      const node = decodeSnapshot(second);
      expect(node.prev).toBeDefined();
      expect(node.prev!.toString()).toBe(prevCid.toString());
    });
  });

  describe("publisher attribution", () => {
    it("encodes snapshot with publisher fields", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const identity = await generateIdentityKeypair();
      const subdocs = {
        doc: new Uint8Array([1, 2, 3]),
      };

      const encoded = await encodeSnapshot(
        subdocs,
        readKey,
        null,
        0,
        1000,
        signingKey,
        identity,
      );
      const node = decodeSnapshot(encoded);

      expect(node.publisher).toEqual(identity.publicKey);
      expect(node.publisherSig).toBeInstanceOf(Uint8Array);
      expect(node.publisherSig!.length).toBe(64);
    });

    it("validates publisher signature", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const identity = await generateIdentityKeypair();

      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
        identity,
      );

      expect(await validateStructure(encoded)).toBe(true);
    });

    it("rejects tampered publisher sig", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const identity = await generateIdentityKeypair();

      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
        identity,
      );

      const node = decodeSnapshot(encoded);
      // Tamper with publisherSig
      const tampered = new Uint8Array(node.publisherSig!);
      tampered[0] ^= 0xff;
      node.publisherSig = tampered;

      // Re-encode with tampered publisherSig — doc sig
      // won't match either
      const reEncoded = dagCbor.encode(node);
      expect(await validateStructure(reEncoded)).toBe(false);
    });

    it("works without publisher (backward compat)", async () => {
      const { readKey, signingKey } = await makeTestKeys();

      // No identity keypair passed
      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
      );
      const node = decodeSnapshot(encoded);

      expect(node.publisher).toBeUndefined();
      expect(node.publisherSig).toBeUndefined();
      expect(await validateStructure(encoded)).toBe(true);
    });

    it("doc signature covers publisher fields", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const identity = await generateIdentityKeypair();

      const encoded = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        0,
        1000,
        signingKey,
        identity,
      );
      const node = decodeSnapshot(encoded);

      // Strip publisher fields — doc sig should fail
      const stripped = { ...node };
      delete (stripped as Record<string, unknown>).publisher;
      delete (stripped as Record<string, unknown>).publisherSig;
      const { signature, ...payloadFields } = stripped;
      const payloadBytes = dagCbor.encode(payloadFields);
      const valid = await verifySignature(
        node.publicKey,
        node.signature,
        payloadBytes,
      );
      expect(valid).toBe(false);
    });
  });

  describe("publisher edge cases", () => {
    it("different publishers in same chain " + "both validate", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const id1 = await generateIdentityKeypair();
      const id2 = await generateIdentityKeypair();

      // Block 1: publisher id1
      const block1 = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        1,
        1000,
        signingKey,
        id1,
      );
      const hash1 = await sha256.digest(block1);
      const cid1 = CID.createV1(0x71, hash1);

      // Block 2: publisher id2, prev=cid1
      const block2 = await encodeSnapshot(
        { doc: new Uint8Array([2]) },
        readKey,
        cid1,
        2,
        2000,
        signingKey,
        id2,
      );

      const node1 = decodeSnapshot(block1);
      const node2 = decodeSnapshot(block2);

      // Both validate independently
      expect(await validateStructure(block1)).toBe(true);
      expect(await validateStructure(block2)).toBe(true);

      // Different publisher keys
      expect(node1.publisher).toEqual(id1.publicKey);
      expect(node2.publisher).toEqual(id2.publicKey);
      expect(node1.publisher).not.toEqual(node2.publisher);
    });

    it(
      "publisher field present but " + "publisherSig missing fails validation",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();
        const identity = await generateIdentityKeypair();

        const encoded = await encodeSnapshot(
          { doc: new Uint8Array([1]) },
          readKey,
          null,
          1,
          1000,
          signingKey,
          identity,
        );

        const node = decodeSnapshot(encoded);
        // Strip publisherSig but keep publisher
        const malformed = { ...node };
        delete (malformed as Record<string, unknown>).publisherSig;

        // Re-encode — doc sig won't match since
        // original was signed with publisherSig
        // included in payload
        const { signature, ...rest } = malformed;
        const reEncoded = dagCbor.encode(malformed);
        expect(await validateStructure(reEncoded)).toBe(false);
      },
    );

    it(
      "publisher sig from wrong identity " + "key fails validation",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();
        const realId = await generateIdentityKeypair();
        const wrongId = await generateIdentityKeypair();

        const encoded = await encodeSnapshot(
          { doc: new Uint8Array([1]) },
          readKey,
          null,
          1,
          1000,
          signingKey,
          realId,
        );

        const node = decodeSnapshot(encoded);

        // Replace publisher with wrongId's pubkey
        // but keep realId's publisherSig
        const tampered = { ...node };
        tampered.publisher = wrongId.publicKey;

        const reEncoded = dagCbor.encode(tampered);
        expect(await validateStructure(reEncoded)).toBe(false);
      },
    );

    it("walkChain preserves publisher " + "fields through chain", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const id = await generateIdentityKeypair();

      const block1 = await encodeSnapshot(
        { doc: new Uint8Array([1]) },
        readKey,
        null,
        1,
        1000,
        signingKey,
        id,
      );
      const hash1 = await sha256.digest(block1);
      const cid1 = CID.createV1(0x71, hash1);

      const block2 = await encodeSnapshot(
        { doc: new Uint8Array([2]) },
        readKey,
        cid1,
        2,
        2000,
        signingKey,
        id,
      );
      const hash2 = await sha256.digest(block2);
      const cid2 = CID.createV1(0x71, hash2);

      const blocks = new Map<string, Uint8Array>();
      blocks.set(cid1.toString(), block1);
      blocks.set(cid2.toString(), block2);

      const getter = async (cid: CID) => {
        const b = blocks.get(cid.toString());
        if (!b) throw new Error("not found");
        return b;
      };

      const nodes: import("./index.js").SnapshotNode[] = [];
      for await (const node of walkChain(cid2, getter)) {
        nodes.push(node);
      }

      expect(nodes).toHaveLength(2);
      // Both have publisher fields
      expect(nodes[0].publisher).toEqual(id.publicKey);
      expect(nodes[1].publisher).toEqual(id.publicKey);
    });
  });

  describe("FetchCoalescerState", () => {
    it("creates empty state", () => {
      const s = createFetchCoalescerState();
      expect(s.pending.size).toBe(0);
      expect(s.inflight.size).toBe(0);
      expect(s.resolved.size).toBe(0);
      expect(s.failed.size).toBe(0);
    });

    it("coalescerNext moves pending to " + "inflight", () => {
      const s = createFetchCoalescerState();
      s.pending.add("cidA");
      s.pending.add("cidB");

      const { toFetch } = coalescerNext(s);
      expect(toFetch.sort()).toEqual(["cidA", "cidB"]);
      expect(s.inflight.has("cidA")).toBe(true);
      expect(s.inflight.has("cidB")).toBe(true);
      expect(s.pending.size).toBe(0);
    });

    it("concurrency limit: 5 pending returns " + "only 3", () => {
      const s = createFetchCoalescerState();
      for (let i = 0; i < 5; i++) {
        s.pending.add(`cid${i}`);
      }
      const { toFetch } = coalescerNext(s);
      expect(toFetch.length).toBe(3);
      expect(s.inflight.size).toBe(3);
      expect(s.pending.size).toBe(2);
    });

    it("multiple next() calls do not re-fetch " + "inflight items", () => {
      const s = createFetchCoalescerState();
      for (let i = 0; i < 5; i++) {
        s.pending.add(`cid${i}`);
      }
      const first = coalescerNext(s);
      expect(first.toFetch.length).toBe(3);

      const second = coalescerNext(s);
      expect(second.toFetch.length).toBe(2);
      expect(s.inflight.size).toBe(5);
      expect(s.pending.size).toBe(0);

      // Third call: nothing left
      const third = coalescerNext(s);
      expect(third.toFetch.length).toBe(0);
    });

    it("coalescerNext skips already resolved", () => {
      const s = createFetchCoalescerState();
      s.pending.add("cidA");
      s.resolved.set("cidA", new Uint8Array([1]));

      const { toFetch } = coalescerNext(s);
      expect(toFetch).toEqual([]);
    });

    it("coalescerNext skips already failed", () => {
      const s = createFetchCoalescerState();
      s.pending.add("cidA");
      s.failed.add("cidA");

      const { toFetch } = coalescerNext(s);
      expect(toFetch).toEqual([]);
    });

    it("coalescerResolve moves inflight to " + "resolved", () => {
      const s = createFetchCoalescerState();
      s.inflight.add("cidA");
      const block = new Uint8Array([1, 2, 3]);

      coalescerResolve(s, "cidA", block);
      expect(s.inflight.has("cidA")).toBe(false);
      expect(s.resolved.get("cidA")).toEqual(block);
    });

    it("coalescerFail moves inflight to " + "failed", () => {
      const s = createFetchCoalescerState();
      s.inflight.add("cidA");

      coalescerFail(s, "cidA");
      expect(s.inflight.has("cidA")).toBe(false);
      expect(s.failed.has("cidA")).toBe(true);
    });

    it("full lifecycle", () => {
      const s = createFetchCoalescerState();
      s.pending.add("cid1");
      s.pending.add("cid2");
      s.pending.add("cid3");

      // Fetch all
      const { toFetch } = coalescerNext(s);
      expect(toFetch.length).toBe(3);

      // Resolve one, fail one
      coalescerResolve(s, "cid1", new Uint8Array([10]));
      coalescerFail(s, "cid2");

      expect(s.inflight.size).toBe(1);
      expect(s.resolved.size).toBe(1);
      expect(s.failed.size).toBe(1);

      // Resolve last
      coalescerResolve(s, "cid3", new Uint8Array([30]));
      expect(s.inflight.size).toBe(0);
      expect(s.resolved.size).toBe(2);
    });
  });
});
