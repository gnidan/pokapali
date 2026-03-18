import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import {
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  generateIdentityKeypair,
  encryptSubdoc,
  signBytes,
  verifyBytes,
} from "@pokapali/crypto";
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  validateSnapshot,
  walkChain,
  ChainCycleError,
  ChainDepthExceededError,
  DEFAULT_MAX_CHAIN_DEPTH,
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

  describe("validateSnapshot", () => {
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
      expect(await validateSnapshot(encoded)).toBe(true);
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
      tampered[tampered.length - 2]! ^= 0xff;

      expect(await validateSnapshot(tampered)).toBe(false);
    });

    it("returns false for garbage bytes", async () => {
      expect(await validateSnapshot(new Uint8Array([0, 1, 2, 3]))).toBe(false);
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

    it("throws ChainCycleError on cycle", async () => {
      // Craft two blocks that point to each other.
      // We can't use encodeSnapshot because prev
      // links form a DAG, so we use dag-cbor directly
      // to fake the cycle.
      const cidA = CID.parse(
        "bafyreigdmqpykrgxyaxtlafqpqhzrb7qy2rh75n" + "hdgm3xbaloyhpmhbseq",
      );
      const cidB = CID.parse(
        "bafyreib2rxk3rybloqtdq5qhxst4asm2tq46ec2" + "t3hunxkrmybawy6rr7i",
      );

      // Block A: prev → cidB
      const nodeA = dagCbor.encode({
        subdocs: {},
        prev: cidB,
        seq: 1,
        ts: 2000,
        publicKey: new Uint8Array(32),
        signature: new Uint8Array(64),
      });

      // Block B: prev → cidA (cycle!)
      const nodeB = dagCbor.encode({
        subdocs: {},
        prev: cidA,
        seq: 0,
        ts: 1000,
        publicKey: new Uint8Array(32),
        signature: new Uint8Array(64),
      });

      const blocks = new Map<string, Uint8Array>();
      blocks.set(cidA.toString(), nodeA);
      blocks.set(cidB.toString(), nodeB);

      const getter = async (cid: CID) => {
        const b = blocks.get(cid.toString());
        if (!b) throw new Error("not found");
        return b;
      };

      const nodes: number[] = [];
      await expect(async () => {
        let i = 0;
        for await (const node of walkChain(cidA, getter)) {
          nodes.push(node.seq);
          if (++i > 100) {
            throw new Error("safety bail: walkChain did not detect cycle");
          }
        }
      }).rejects.toThrow(ChainCycleError);
    });

    it("throws ChainDepthExceededError at maxDepth", async () => {
      // Build a linear chain of 5 blocks, walk with
      // maxDepth=3 — should throw after yielding 3.
      const { readKey, signingKey } = await makeTestKeys();
      const blocks = new Map<string, Uint8Array>();
      let prevCid: CID | null = null;

      for (let i = 0; i < 5; i++) {
        const encoded = await encodeSnapshot(
          { doc: new Uint8Array([i]) },
          readKey,
          prevCid,
          i,
          (i + 1) * 1000,
          signingKey,
        );
        const cid = await cidFromBytes(encoded);
        blocks.set(cid.toString(), encoded);
        prevCid = cid;
      }

      const getter = async (cid: CID) => {
        const b = blocks.get(cid.toString());
        if (!b) throw new Error("not found");
        return b;
      };

      const nodes: number[] = [];
      await expect(async () => {
        for await (const node of walkChain(prevCid!, getter, { maxDepth: 3 })) {
          nodes.push(node.seq);
        }
      }).rejects.toThrow(ChainDepthExceededError);
      // Should have yielded exactly 3 before throwing
      expect(nodes).toEqual([4, 3, 2]);
    });

    it("respects custom maxDepth", async () => {
      // Chain of 2 blocks, maxDepth=10 — no error
      const { readKey, signingKey } = await makeTestKeys();
      const blocks = new Map<string, Uint8Array>();

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

      const getter = async (cid: CID) => {
        const b = blocks.get(cid.toString());
        if (!b) throw new Error("not found");
        return b;
      };

      const nodes: number[] = [];
      for await (const node of walkChain(secondCid, getter, { maxDepth: 10 })) {
        nodes.push(node.seq);
      }
      expect(nodes).toEqual([1, 0]);
    });

    it("exports DEFAULT_MAX_CHAIN_DEPTH", () => {
      expect(typeof DEFAULT_MAX_CHAIN_DEPTH).toBe("number");
      expect(DEFAULT_MAX_CHAIN_DEPTH).toBeGreaterThan(0);
    });

    it("error types have descriptive messages", async () => {
      const err1 = new ChainCycleError("cid-abc");
      expect(err1.message).toContain("cid-abc");
      expect(err1.name).toBe("ChainCycleError");

      const err2 = new ChainDepthExceededError(100);
      expect(err2.message).toContain("100");
      expect(err2.name).toBe("ChainDepthExceededError");
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

      expect(await validateSnapshot(encoded)).toBe(true);
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
      tampered[0]! ^= 0xff;
      node.publisherSig = tampered;

      // Re-encode with tampered publisherSig — doc sig
      // won't match either
      const reEncoded = dagCbor.encode(node);
      expect(await validateSnapshot(reEncoded)).toBe(false);
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
      expect(await validateSnapshot(encoded)).toBe(true);
    });

    it(
      "encodeSnapshot produces both publisher " + "fields or neither",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();
        const identity = await generateIdentityKeypair();

        // With identity → both defined
        const withId = decodeSnapshot(
          await encodeSnapshot(
            { doc: new Uint8Array([1]) },
            readKey,
            null,
            0,
            1000,
            signingKey,
            identity,
          ),
        );
        expect(withId.publisher).toBeDefined();
        expect(withId.publisherSig).toBeDefined();

        // Without identity → both undefined
        const withoutId = decodeSnapshot(
          await encodeSnapshot(
            { doc: new Uint8Array([1]) },
            readKey,
            null,
            0,
            1000,
            signingKey,
          ),
        );
        expect(withoutId.publisher).toBeUndefined();
        expect(withoutId.publisherSig).toBeUndefined();
      },
    );

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
      const valid = await verifyBytes(
        node.publicKey,
        node.signature,
        payloadBytes,
      );
      expect(valid).toBe(false);
    });

    it("rejects publisher without publisherSig", async () => {
      const { readKey, signingKey } = await makeTestKeys();
      const identity = await generateIdentityKeypair();
      const subdocs = {
        doc: await encryptSubdoc(readKey, new Uint8Array([1])),
      };

      // Hand-craft a block with publisher but no
      // publisherSig, then sign it with the doc key.
      // This simulates an attacker claiming a publisher
      // identity without proving it.
      const payload = {
        subdocs,
        prev: null,
        seq: 0,
        ts: 1000,
        publicKey: signingKey.publicKey,
        publisher: identity.publicKey,
      };
      const payloadBytes = dagCbor.encode(payload);
      const signature = await signBytes(signingKey, payloadBytes);
      const block = dagCbor.encode({
        ...payload,
        signature,
      });

      expect(await validateSnapshot(block)).toBe(false);
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
      expect(await validateSnapshot(block1)).toBe(true);
      expect(await validateSnapshot(block2)).toBe(true);

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
        expect(await validateSnapshot(reEncoded)).toBe(false);
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
        expect(await validateSnapshot(reEncoded)).toBe(false);
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
      expect(nodes[0]!.publisher).toEqual(id.publicKey);
      expect(nodes[1]!.publisher).toEqual(id.publicKey);
    });
  });

  describe("publisher security", () => {
    it(
      "field-stripping attack: removing both " +
        "publisher fields invalidates doc sig",
      async () => {
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
        expect(await validateSnapshot(encoded)).toBe(true);

        // Strip both publisher fields, keep
        // original doc signature
        const node = decodeSnapshot(encoded);
        const stripped = { ...node };
        delete (stripped as Record<string, unknown>).publisher;
        delete (stripped as Record<string, unknown>).publisherSig;

        const reEncoded = dagCbor.encode(stripped);
        // Doc sig was over payload WITH publisher
        // fields — stripped payload won't match
        expect(await validateSnapshot(reEncoded)).toBe(false);
      },
    );

    it(
      "valid doc sig with forged publisher " + "sig fails validation",
      async () => {
        const { signingKey } = await makeTestKeys();
        const identity = await generateIdentityKeypair();

        // Forged publisherSig (random bytes)
        const forgedSig = new Uint8Array(64).fill(0xde);

        const payload = {
          subdocs: { doc: new Uint8Array([1]) },
          prev: null,
          seq: 0,
          ts: 1000,
          publicKey: signingKey.publicKey,
          publisher: identity.publicKey,
          publisherSig: forgedSig,
        };

        // Doc key signs the full payload (valid
        // doc sig over forged publisher fields)
        const payloadBytes = dagCbor.encode(payload);
        const signature = await signBytes(signingKey, payloadBytes);

        const block = dagCbor.encode({
          ...payload,
          signature,
        });

        // Doc sig valid, publisher sig forged
        expect(await validateSnapshot(block)).toBe(false);
      },
    );

    it(
      "publisher sig replay: sig from " +
        "(seq=1, ts=1000) rejected on " +
        "(seq=2, ts=2000)",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();
        const identity = await generateIdentityKeypair();

        // Create valid snapshot A
        const blockA = await encodeSnapshot(
          { doc: new Uint8Array([1]) },
          readKey,
          null,
          1,
          1000,
          signingKey,
          identity,
        );
        expect(await validateSnapshot(blockA)).toBe(true);

        const nodeA = decodeSnapshot(blockA);
        const stolenPubSig = nodeA.publisherSig!;

        // Hand-craft snapshot B with different
        // seq/ts but stolen publisherSig
        const payload = {
          subdocs: { doc: new Uint8Array([99]) },
          prev: null,
          seq: 2,
          ts: 2000,
          publicKey: signingKey.publicKey,
          publisher: identity.publicKey,
          publisherSig: stolenPubSig,
        };

        // Valid doc sig over crafted payload
        const payloadBytes = dagCbor.encode(payload);
        const signature = await signBytes(signingKey, payloadBytes);

        const block = dagCbor.encode({
          ...payload,
          signature,
        });

        // Publisher sig was for (seq=1, ts=1000),
        // not (seq=2, ts=2000)
        expect(await validateSnapshot(block)).toBe(false);
      },
    );
  });

  describe("encode→decode→verify round-trip", () => {
    it(
      "round-trip with identity key: both " +
        "doc sig and publisher sig verify",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();
        const identity = await generateIdentityKeypair();

        const encoded = await encodeSnapshot(
          { doc: new Uint8Array([1, 2, 3]) },
          readKey,
          null,
          5,
          9999,
          signingKey,
          identity,
        );

        const node = decodeSnapshot(encoded);

        // Verify doc signature independently
        const payload = {
          subdocs: node.subdocs,
          prev: node.prev,
          seq: node.seq,
          ts: node.ts,
          publicKey: node.publicKey,
          publisher: node.publisher,
          publisherSig: node.publisherSig,
        };
        const payloadBytes = dagCbor.encode(payload);
        expect(
          await verifyBytes(node.publicKey, node.signature, payloadBytes),
        ).toBe(true);

        // Verify publisher signature independently
        const pubPayload = {
          publicKey: node.publicKey,
          seq: node.seq,
          ts: node.ts,
        };
        const pubBytes = dagCbor.encode(pubPayload);
        expect(
          await verifyBytes(node.publisher!, node.publisherSig!, pubBytes),
        ).toBe(true);

        // And validateSnapshot confirms both
        expect(await validateSnapshot(encoded)).toBe(true);
      },
    );

    it(
      "round-trip without identity key: " +
        "doc sig verifies, no publisher fields",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();

        const encoded = await encodeSnapshot(
          { doc: new Uint8Array([4, 5, 6]) },
          readKey,
          null,
          0,
          1000,
          signingKey,
        );

        const node = decodeSnapshot(encoded);
        expect(node.publisher).toBeUndefined();
        expect(node.publisherSig).toBeUndefined();

        // Doc sig still valid
        const payload = {
          subdocs: node.subdocs,
          prev: node.prev,
          seq: node.seq,
          ts: node.ts,
          publicKey: node.publicKey,
        };
        const payloadBytes = dagCbor.encode(payload);
        expect(
          await verifyBytes(node.publicKey, node.signature, payloadBytes),
        ).toBe(true);

        expect(await validateSnapshot(encoded)).toBe(true);
      },
    );
  });

  describe("DAG-CBOR determinism", () => {
    it("same payload encoded twice produces " + "identical bytes", () => {
      const payload = {
        subdocs: {
          doc: new Uint8Array([1, 2, 3]),
        },
        prev: null,
        seq: 42,
        ts: 123456,
        publicKey: new Uint8Array(32).fill(0xaa),
      };

      const bytes1 = dagCbor.encode(payload);
      const bytes2 = dagCbor.encode(payload);
      expect(bytes1).toEqual(bytes2);
    });

    it(
      "deterministic across encodeSnapshot " + "calls (same keys, same data)",
      async () => {
        const { readKey, signingKey } = await makeTestKeys();

        // Note: encodeSnapshot uses encryption
        // which has random IVs, so the encoded
        // bytes will differ. But the signable
        // payload structure is deterministic.
        const encoded1 = await encodeSnapshot(
          { doc: new Uint8Array([1]) },
          readKey,
          null,
          0,
          1000,
          signingKey,
        );
        const encoded2 = await encodeSnapshot(
          { doc: new Uint8Array([1]) },
          readKey,
          null,
          0,
          1000,
          signingKey,
        );

        const node1 = decodeSnapshot(encoded1);
        const node2 = decodeSnapshot(encoded2);

        // Structural fields match
        expect(node1.seq).toBe(node2.seq);
        expect(node1.ts).toBe(node2.ts);
        expect(node1.prev).toEqual(node2.prev);
        expect(node1.publicKey).toEqual(node2.publicKey);

        // Both validate independently
        expect(await validateSnapshot(encoded1)).toBe(true);
        expect(await validateSnapshot(encoded2)).toBe(true);
      },
    );
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
