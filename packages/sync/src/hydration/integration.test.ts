/**
 * Integration test -- proves the full Phase 4
 * pipeline end-to-end:
 *
 * Document + SubdocManager -> Edits edits ->
 * Convergence closes epochs -> Store
 * persists -> mock snapshot -> hydrate -> backfill ->
 * verify match
 */
import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/blocks";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import type { Codec } from "@pokapali/codec";
import { Document } from "@pokapali/document";
import type { Document as DocumentType } from "@pokapali/document";
import { Edits } from "../edits.js";
import type { Edits as EditsType } from "../edits.js";
import { Store } from "@pokapali/store";
import { fromSnapshots } from "./hydrator.js";
import { verify } from "./verifier.js";

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
  };
}

async function makeKeys() {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, "test-app", ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  return { keys, signingKey };
}

async function makeSnapshot(
  yDoc: Y.Doc,
  readKey: CryptoKey,
  signingKey: Awaited<ReturnType<typeof ed25519KeyPairFromSeed>>,
  prev: CID | null,
  seq: number,
): Promise<{ cid: CID; block: Uint8Array }> {
  const plaintexts: Record<string, Uint8Array> = {
    content: Y.encodeStateAsUpdate(yDoc),
  };
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

describe("Phase 4 hydration integration", () => {
  let document: DocumentType;
  let edits: EditsType;
  let store: Store;

  afterEach(() => {
    edits?.destroy();
    document?.destroy();
    store?.destroy();
  });

  it(
    "full pipeline: edit -> converge -> persist " +
      "-> snapshot -> hydrate -> backfill " +
      "-> verify",
    async () => {
      const { keys, signingKey } = await makeKeys();
      const blocks = new Map<string, Uint8Array>();
      const dbName = `test-hydration-int-${Math.random()}`;

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
      store = await Store.create(dbName);

      await edits.start();

      // --- Phase 1: Local edits ---
      const yDoc = docs.get("content")!;
      yDoc.getArray("data").push(["edit-1"]);
      yDoc.getArray("data").push(["edit-2"]);

      // Persist edits
      const ch = document.channel("content");
      for (const e of toArray(ch.tree).flatMap((ep) => ep.edits)) {
        await store.persistEdit("content", e);
      }

      // --- Phase 2: Converge ---
      ch.closeEpoch();
      await store.persistEpochBoundary(
        "content",
        0,
        toArray(ch.tree)[0]!.boundary,
      );

      // --- Phase 3: Create snapshot of
      //     converged state ---
      const { cid, block } = await makeSnapshot(
        yDoc,
        keys.readKey,
        signingKey,
        null,
        1,
      );
      blocks.set(cid.toString(), block);

      // --- Phase 4: Post-snapshot edit ---
      yDoc.getArray("data").push(["post-snap"]);

      // Persist post-snapshot edit
      const postEdits = toArray(ch.tree).at(-1)!.edits;
      for (const e of postEdits) {
        await store.persistEdit("content", e);
      }

      // --- Phase 5: Hydrate from snapshot ---
      const hydrated = await fromSnapshots({
        tipCid: cid,
        blockGetter: async (c: CID) => {
          const b = blocks.get(c.toString());
          if (!b) {
            throw new Error(`missing ${c}`);
          }
          return b;
        },
        readKey: keys.readKey,
      });

      // --- Phase 6: Verify hydration ---
      const [result] = await verify({
        document,
        subdocManager: manager,
        channelNames: ["content"],
        codec,
        snapshotEpochs: hydrated,
      });

      expect(result!.match).toBe(true);
      expect(result!.snapshotEpochCount).toBe(1);
      // post-snap edit should be backfilled
      expect(result!.backfilledEditCount).toBeGreaterThan(0);
      expect(result!.channel).toBe("content");
    },
  );

  it("progressive snapshots with " + "interleaved edits", async () => {
    const { keys, signingKey } = await makeKeys();
    const blocks = new Map<string, Uint8Array>();
    const dbName = `test-hydration-prog-${Math.random()}`;

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
    store = await Store.create(dbName);

    await edits.start();

    const yDoc = docs.get("content")!;
    const ch = document.channel("content");
    let prevCid: CID | null = null;

    // 3 rounds: edit -> converge -> snapshot
    for (let i = 1; i <= 3; i++) {
      yDoc.getArray("data").push([`round-${i}`]);

      // Persist edits
      const epochs = toArray(ch.tree);
      const tip = epochs[epochs.length - 1]!;
      for (const e of tip.edits) {
        await store.persistEdit("content", e);
      }

      // Converge
      ch.closeEpoch();
      const closedIdx = epochs.length - 1;
      await store.persistEpochBoundary(
        "content",
        closedIdx,
        toArray(ch.tree)[closedIdx]!.boundary,
      );

      // Snapshot
      const snap = await makeSnapshot(
        yDoc,
        keys.readKey,
        signingKey,
        prevCid,
        i,
      );
      blocks.set(snap.cid.toString(), snap.block);
      prevCid = snap.cid;
    }

    // Hydrate from tip snapshot
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

    // Verify
    const [result] = await verify({
      document,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
      snapshotEpochs: hydrated,
    });

    expect(result!.match).toBe(true);
    expect(result!.snapshotEpochCount).toBe(3);
    // All edits covered by snapshots
    expect(result!.backfilledEditCount).toBe(0);
  });
});
