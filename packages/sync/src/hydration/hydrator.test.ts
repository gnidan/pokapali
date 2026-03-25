import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/blocks";
import { fromSnapshots } from "./hydrator.js";

// -- Helpers --

const DAG_CBOR_CODE = 0x71;

async function makeKeys() {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, "test-app", ["content", "comments"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  return { keys, signingKey };
}

async function encodeYDocs(
  subdocs: Record<string, Y.Doc>,
  readKey: CryptoKey,
  signingKey: Awaited<ReturnType<typeof ed25519KeyPairFromSeed>>,
  prev: CID | null,
  seq: number,
): Promise<{ cid: CID; block: Uint8Array }> {
  const plaintexts: Record<string, Uint8Array> = {};
  for (const [ns, doc] of Object.entries(subdocs)) {
    plaintexts[ns] = Y.encodeStateAsUpdate(doc);
  }
  const block = await encodeSnapshot(
    plaintexts,
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

// -- Tests --

describe("fromSnapshots", () => {
  it("single snapshot -> one epoch per channel", async () => {
    const { keys, signingKey } = await makeKeys();

    const contentDoc = new Y.Doc();
    contentDoc.getText("content").insert(0, "hello");

    const { cid, block } = await encodeYDocs(
      { content: contentDoc },
      keys.readKey,
      signingKey,
      null,
      1,
    );

    const blocks = new Map<string, Uint8Array>();
    blocks.set(cid.toString(), block);

    const result = await fromSnapshots({
      tipCid: cid,
      blockGetter: async (c: CID) => {
        const b = blocks.get(c.toString());
        if (!b) throw new Error(`missing ${c}`);
        return b;
      },
      readKey: keys.readKey,
    });

    expect(result.has("content")).toBe(true);
    const epochs = result.get("content")!;
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.boundary.tag).toBe("snapshotted");
    expect(epochs[0]!.edits).toHaveLength(1);
    // The edit payload should be the Y.Doc state
    expect(epochs[0]!.edits[0]!.origin).toBe("hydrate");
  });

  it("chain of 3 -> 3 epochs oldest-first", async () => {
    const { keys, signingKey } = await makeKeys();
    const blocks = new Map<string, Uint8Array>();

    // Snapshot 1 (oldest, no prev)
    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "one");
    const snap1 = await encodeYDocs(
      { content: doc1 },
      keys.readKey,
      signingKey,
      null,
      1,
    );
    blocks.set(snap1.cid.toString(), snap1.block);

    // Snapshot 2
    const doc2 = new Y.Doc();
    doc2.getText("content").insert(0, "two");
    const snap2 = await encodeYDocs(
      { content: doc2 },
      keys.readKey,
      signingKey,
      snap1.cid,
      2,
    );
    blocks.set(snap2.cid.toString(), snap2.block);

    // Snapshot 3 (newest, tip)
    const doc3 = new Y.Doc();
    doc3.getText("content").insert(0, "three");
    const snap3 = await encodeYDocs(
      { content: doc3 },
      keys.readKey,
      signingKey,
      snap2.cid,
      3,
    );
    blocks.set(snap3.cid.toString(), snap3.block);

    const result = await fromSnapshots({
      tipCid: snap3.cid,
      blockGetter: async (c: CID) => {
        const b = blocks.get(c.toString());
        if (!b) throw new Error(`missing ${c}`);
        return b;
      },
      readKey: keys.readKey,
    });

    const epochs = result.get("content")!;
    expect(epochs).toHaveLength(3);

    // Verify oldest-first ordering: each epoch
    // should have a snapshotted boundary
    for (const ep of epochs) {
      expect(ep.boundary.tag).toBe("snapshotted");
    }
  });

  it("decryption failure propagates error", async () => {
    const { keys, signingKey } = await makeKeys();

    const contentDoc = new Y.Doc();
    contentDoc.getText("content").insert(0, "data");

    const { cid, block } = await encodeYDocs(
      { content: contentDoc },
      keys.readKey,
      signingKey,
      null,
      1,
    );

    const blocks = new Map<string, Uint8Array>();
    blocks.set(cid.toString(), block);

    // Use a different readKey for decryption
    // -> should fail
    const wrongSecret = generateAdminSecret();
    const wrongKeys = await deriveDocKeys(wrongSecret, "test-app", ["content"]);

    await expect(
      fromSnapshots({
        tipCid: cid,
        blockGetter: async (c: CID) => {
          const b = blocks.get(c.toString());
          if (!b) {
            throw new Error(`missing ${c}`);
          }
          return b;
        },
        readKey: wrongKeys.readKey,
      }),
    ).rejects.toThrow();
  });

  it(
    "property: N-link chain -> N epochs " +
      "per channel, oldest-first, all snapshotted",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (chainLen) => {
          const { keys, signingKey } = await makeKeys();
          const blocks = new Map<string, Uint8Array>();

          let prevCid: CID | null = null;
          for (let i = 1; i <= chainLen; i++) {
            const doc = new Y.Doc();
            doc.getText("content").insert(0, `snap-${i}`);
            const plaintexts: Record<string, Uint8Array> = {
              content: Y.encodeStateAsUpdate(doc),
            };
            const block = await encodeSnapshot(
              plaintexts,
              keys.readKey,
              prevCid,
              i,
              Date.now(),
              signingKey,
            );
            const hash = await sha256.digest(block);
            const cid = CID.createV1(DAG_CBOR_CODE, hash);
            blocks.set(cid.toString(), block);
            prevCid = cid;
          }

          const result = await fromSnapshots({
            tipCid: prevCid!,
            blockGetter: async (c: CID) => {
              const b = blocks.get(c.toString());
              if (!b) {
                throw new Error(`missing ${c}`);
              }
              return b;
            },
            readKey: keys.readKey,
          });

          const epochs = result.get("content")!;
          expect(epochs).toHaveLength(chainLen);

          // All boundaries snapshotted
          for (const ep of epochs) {
            expect(ep.boundary.tag).toBe("snapshotted");
          }

          // Each epoch has exactly one edit
          for (const ep of epochs) {
            expect(ep.edits).toHaveLength(1);
            expect(ep.edits[0]!.origin).toBe("hydrate");
          }
        }),
        { numRuns: 20 },
      );
    },
  );
});
