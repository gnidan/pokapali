/**
 * Tests for verify -- proves that a hydrated epoch
 * tree (from snapshots + backfilled live edits)
 * matches the live Y.Doc state.
 */
import { describe, it, expect, afterEach } from "vitest";
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
import type { SubdocManager } from "@pokapali/subdocs";
import type { Codec } from "@pokapali/codec";
import { Document } from "@pokapali/document";
import type { Document as DocumentType } from "@pokapali/document";
import { Edits } from "../edits.js";
import type { Edits as EditsType } from "../edits.js";
import { verify } from "./verifier.js";
import type { VerifyResult } from "./verifier.js";

// -- Helpers --

const DAG_CBOR_CODE = 0x71;

function fakeIdentity() {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeCapability() {
  return {
    channels: new Set(["content", "comments"]),
    canPushSnapshots: false,
    isAdmin: false,
  };
}

function mockSubdocManager(channelNames: string[]): {
  manager: SubdocManager;
  docs: Map<string, Y.Doc>;
} {
  const docs = new Map<string, Y.Doc>();
  for (const name of channelNames) {
    docs.set(name, new Y.Doc());
  }

  const manager: SubdocManager = {
    subdoc(ns: string): Y.Doc {
      let doc = docs.get(ns);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(ns, doc);
      }
      return doc;
    },
    get metaDoc(): Y.Doc {
      return new Y.Doc();
    },
    encodeAll() {
      return {};
    },
    applySnapshot() {},
    get isDirty() {
      return false;
    },
    on() {},
    off() {},
    whenLoaded: Promise.resolve(),
    destroy() {},
  };

  return { manager, docs };
}

function yjsCodec(): Codec {
  return {
    merge(a: Uint8Array, b: Uint8Array): Uint8Array {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, a);
      Y.applyUpdate(doc, b);
      return Y.encodeStateAsUpdate(doc);
    },
    diff(state: Uint8Array, base: Uint8Array): Uint8Array {
      const baseDoc = new Y.Doc();
      Y.applyUpdate(baseDoc, base);
      const sv = Y.encodeStateVector(baseDoc);
      const stateDoc = new Y.Doc();
      Y.applyUpdate(stateDoc, state);
      return Y.encodeStateAsUpdate(stateDoc, sv);
    },
    apply(base: Uint8Array, update: Uint8Array): Uint8Array {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, base);
      Y.applyUpdate(doc, update);
      return Y.encodeStateAsUpdate(doc);
    },
    empty(): Uint8Array {
      return Y.encodeStateAsUpdate(new Y.Doc());
    },
    contains(snapshot: Uint8Array, e: Uint8Array): boolean {
      const base = new Y.Doc();
      Y.applyUpdate(base, snapshot);
      const sv = Y.encodeStateVector(base);
      const editDoc = new Y.Doc();
      Y.applyUpdate(editDoc, e);
      const d = Y.encodeStateAsUpdate(editDoc, sv);
      return d.length <= 2;
    },
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
    },
  };
}

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

describe("verify", () => {
  let document: DocumentType;
  let edits: EditsType;

  afterEach(() => {
    edits?.destroy();
    document?.destroy();
  });

  it("fresh doc -- no snapshots, live edits only", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();

    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    edits = Edits.create({
      subdocManager: manager,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Local edits
    docs.get("content")!.getArray("data").push(["hello"]);
    docs.get("content")!.getArray("data").push(["world"]);

    const results = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
      snapshotEpochs: null,
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.match).toBe(true);
    expect(result.channel).toBe("content");
    expect(result.snapshotEpochCount).toBe(0);
    expect(result.backfilledEditCount).toBeGreaterThan(0);
  });

  it("1 snapshot + post-snapshot edits", async () => {
    const { keys, signingKey } = await makeKeys();
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();
    const blocks = new Map<string, Uint8Array>();

    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    edits = Edits.create({
      subdocManager: manager,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Pre-snapshot edit
    const yDoc = docs.get("content")!;
    yDoc.getArray("data").push(["before-snap"]);

    // Create snapshot of current state
    const snapDoc = new Y.Doc();
    Y.applyUpdate(snapDoc, Y.encodeStateAsUpdate(yDoc));
    const { cid, block } = await encodeYDocs(
      { content: snapDoc },
      keys.readKey,
      signingKey,
      null,
      1,
    );
    blocks.set(cid.toString(), block);

    // Post-snapshot edit (not in snapshot)
    yDoc.getArray("data").push(["after-snap"]);

    // Hydrate from snapshot
    const { fromSnapshots } = await import("./hydrator.js");
    const hydrated = await fromSnapshots({
      tipCid: cid,
      blockGetter: async (c: CID) => {
        const b = blocks.get(c.toString());
        if (!b) throw new Error(`missing ${c}`);
        return b;
      },
      readKey: keys.readKey,
    });

    const [result] = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
      snapshotEpochs: hydrated,
    });

    expect(result!.match).toBe(true);
    expect(result!.snapshotEpochCount).toBe(1);
    // The post-snapshot edit should be backfilled
    expect(result!.backfilledEditCount).toBeGreaterThan(0);
  });

  it("3 snapshots progressive", async () => {
    const { keys, signingKey } = await makeKeys();
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();
    const blocks = new Map<string, Uint8Array>();

    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    edits = Edits.create({
      subdocManager: manager,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    const yDoc = docs.get("content")!;

    // Build 3 progressive snapshots
    let prevCid: CID | null = null;
    for (let i = 1; i <= 3; i++) {
      yDoc.getArray("data").push([`snap-${i}`]);
      const snapDoc = new Y.Doc();
      Y.applyUpdate(snapDoc, Y.encodeStateAsUpdate(yDoc));
      const snap = await encodeYDocs(
        { content: snapDoc },
        keys.readKey,
        signingKey,
        prevCid,
        i,
      );
      blocks.set(snap.cid.toString(), snap.block);
      prevCid = snap.cid;
    }

    // Hydrate
    const { fromSnapshots } = await import("./hydrator.js");
    const hydrated = await fromSnapshots({
      tipCid: prevCid!,
      blockGetter: async (c: CID) => {
        const b = blocks.get(c.toString());
        if (!b) throw new Error(`missing ${c}`);
        return b;
      },
      readKey: keys.readKey,
    });

    const [result] = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
      snapshotEpochs: hydrated,
    });

    expect(result!.match).toBe(true);
    expect(result!.snapshotEpochCount).toBe(3);
    // All edits covered by snapshots -- no backfill
    expect(result!.backfilledEditCount).toBe(0);
  });

  it("divergence injected -- extra edit in Y.Doc", async () => {
    const { keys, signingKey } = await makeKeys();
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();
    const blocks = new Map<string, Uint8Array>();

    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    edits = Edits.create({
      subdocManager: manager,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    const yDoc = docs.get("content")!;
    yDoc.getArray("data").push(["in-snap"]);

    // Create snapshot
    const snapDoc = new Y.Doc();
    Y.applyUpdate(snapDoc, Y.encodeStateAsUpdate(yDoc));
    const { cid, block } = await encodeYDocs(
      { content: snapDoc },
      keys.readKey,
      signingKey,
      null,
      1,
    );
    blocks.set(cid.toString(), block);

    // Post-snapshot edit (in both tree and Y.Doc)
    yDoc.getArray("data").push(["post-snap"]);

    // Inject divergence: extra edit in Y.Doc only
    // (not in epoch tree)
    edits.destroy();
    const phantomDoc = new Y.Doc();
    phantomDoc.getArray("extra").push(["phantom"]);
    Y.applyUpdate(yDoc, Y.encodeStateAsUpdate(phantomDoc));

    // Hydrate
    const { fromSnapshots } = await import("./hydrator.js");
    const hydrated = await fromSnapshots({
      tipCid: cid,
      blockGetter: async (c: CID) => {
        const b = blocks.get(c.toString());
        if (!b) throw new Error(`missing ${c}`);
        return b;
      },
      readKey: keys.readKey,
    });

    const [result] = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
      snapshotEpochs: hydrated,
    });

    expect(result!.match).toBe(false);
    expect(result!.details).toBeDefined();
  });

  it("multi-channel -- verifies all channels", async () => {
    const { manager, docs } = mockSubdocManager(["content", "comments"]);
    const codec = yjsCodec();

    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    edits = Edits.create({
      subdocManager: manager,
      document,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Edit both channels
    docs.get("content")!.getArray("data").push(["content-edit"]);
    docs.get("comments")!.getArray("data").push(["comment-edit"]);

    const results = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content", "comments"],
      codec,
      snapshotEpochs: null,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.match).toBe(true);
    expect(results[0]!.channel).toBe("content");
    expect(results[1]!.match).toBe(true);
    expect(results[1]!.channel).toBe("comments");
  });

  it(
    "property: N snapshots x M post-snapshot " +
      "edits -> hydrate -> verify matches",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          async (numSnaps, numPostEdits) => {
            const { keys, signingKey } = await makeKeys();
            const { manager, docs } = mockSubdocManager(["content"]);
            const codec = yjsCodec();
            const blocks = new Map<string, Uint8Array>();

            const d = Document.create({
              identity: fakeIdentity(),
              capability: fakeCapability(),
            });
            const br = Edits.create({
              subdocManager: manager,
              document: d,
              channelNames: ["content"],
              localAuthor: "aabb",
            });
            await br.start();

            const yDoc = docs.get("content")!;
            let prevCid: CID | null = null;

            // Build N snapshots
            for (let i = 1; i <= numSnaps; i++) {
              yDoc.getArray("data").push([`s-${i}`]);
              const snapDoc = new Y.Doc();
              Y.applyUpdate(snapDoc, Y.encodeStateAsUpdate(yDoc));
              const plaintexts: Record<string, Uint8Array> = {
                content: Y.encodeStateAsUpdate(snapDoc),
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
              const cid = CID.createV1(0x71, hash);
              blocks.set(cid.toString(), block);
              prevCid = cid;
            }

            // M post-snapshot edits
            for (let j = 0; j < numPostEdits; j++) {
              yDoc.getArray("data").push([`p-${j}`]);
            }

            // Hydrate
            const { fromSnapshots } = await import("./hydrator.js");
            const hydrated = await fromSnapshots({
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

            const [result] = await verify({
              document: d,
              subdocManager: manager,
              channelNames: ["content"],
              codec,
              snapshotEpochs: hydrated,
            });

            expect(result!.match).toBe(true);
            expect(result!.snapshotEpochCount).toBe(numSnaps);

            br.destroy();
            d.destroy();
          },
        ),
        { numRuns: 30 },
      );
    },
  );
});
