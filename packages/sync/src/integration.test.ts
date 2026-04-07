/**
 * Integration test -- proves the full Phase 4b
 * pipeline composes:
 *
 * SubdocProvider -> Edits -> Document -> Store
 *
 * Convergence is mocked (direct closeEpoch call)
 * to keep the test deterministic.
 */
import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { toArray, measureTree } from "@pokapali/finger-tree";
import type { SubdocProvider } from "./subdoc-provider.js";
import {
  Document,
  epochMeasured,
  fromEpochs,
  Fingerprint,
} from "@pokapali/document";
import type { Document as DocumentType } from "@pokapali/document";
import { Store } from "@pokapali/store";
import { Edits } from "./edits.js";
import type { Edits as EditsType } from "./edits.js";

const TEST_DOC = "k51test-integration";

// -- Helpers --

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

function fakeCodec(): any {
  return {
    merge: () => new Uint8Array(),
    diff: () => new Uint8Array(),
    clockSum: () => 0,
    createSurface: () => ({
      handle: {},
      applyEdit: () => {},
      applyState: () => {},
      onLocalEdit: () => () => {},
      destroy: () => {},
    }),
  };
}

function mockSubdocProvider(channelNames: string[]): {
  provider: SubdocProvider;
  docs: Map<string, Y.Doc>;
} {
  const docs = new Map<string, Y.Doc>();
  for (const name of channelNames) {
    docs.set(name, new Y.Doc());
  }

  const provider: SubdocProvider = {
    subdoc(ns: string): Y.Doc {
      let doc = docs.get(ns);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(ns, doc);
      }
      return doc;
    },
    whenLoaded: Promise.resolve(),
  };

  return { provider, docs };
}

// -- Tests --

describe("Phase 4b bridge integration", () => {
  let document: DocumentType;
  let edits: EditsType;
  let store: Store;

  afterEach(() => {
    edits?.destroy();
    document?.destroy();
    store?.close();
  });

  it(
    "full pipeline: edit -> channel -> persist " +
      "-> converge -> load round-trip",
    async () => {
      const dbName = `test-integration-${Math.random()}`;

      // 1. Create all components
      const { provider, docs } = mockSubdocProvider(["content"]);
      document = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec: fakeCodec(),
      });
      edits = Edits.create({
        subdocProvider: provider,
        document,
        channelNames: ["content"],
        localAuthor: "aabb",
      });
      store = await Store.create(dbName);

      // 2. Start Edits
      await edits.start();

      // 3. Simulate local edit
      const yDoc = docs.get("content")!;
      yDoc.getArray("data").push(["hello"]);

      // Verify edit in channel tree
      const ch = document.channel("content");
      let epochs = toArray(ch.tree);
      expect(epochs).toHaveLength(1);
      expect(epochs[0]!.edits.length).toBeGreaterThan(0);
      expect(epochs[0]!.edits[0]!.origin).toBe("local");
      expect(epochs[0]!.edits[0]!.author).toBe("aabb");

      // 4. Persist the local edit
      const hist = store.documents.get(TEST_DOC).history("content");
      for (const e of epochs[0]!.edits) {
        await hist.append(0, e);
      }

      // 5. Simulate remote edit
      const remoteDoc = new Y.Doc();
      remoteDoc.getArray("data").push(["world"]);
      const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);
      Y.applyUpdate(yDoc, remoteUpdate, "some-provider");

      // Verify remote edit routed
      epochs = toArray(ch.tree);
      const allEdits = epochs.flatMap((ep) => ep.edits);
      const remoteEdits = allEdits.filter((e) => e.origin === "sync");
      expect(remoteEdits).toHaveLength(1);
      expect(remoteEdits[0]!.author).toBe("");

      // Persist remote edit
      await hist.append(0, remoteEdits[0]!);

      // 6. Simulate convergence (mock -- direct
      //    closeEpoch instead of Convergence)
      ch.closeEpoch();

      // Verify epoch closed in channel tree
      epochs = toArray(ch.tree);
      expect(epochs).toHaveLength(2);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      expect(epochs[1]!.boundary.tag).toBe("open");

      // Persist epoch boundary
      await hist.close(0, epochs[0]!.boundary);

      // 7. Load from Store -- verify round-trip
      const loaded = await hist.load();
      expect(loaded).toHaveLength(2);

      // Epoch 0: two edits, closed
      expect(loaded[0]!.edits).toHaveLength(2);
      expect(loaded[0]!.boundary.tag).toBe("closed");
      expect(loaded[0]!.edits[0]!.origin).toBe("local");
      expect(loaded[0]!.edits[0]!.author).toBe("aabb");
      expect(loaded[0]!.edits[1]!.origin).toBe("sync");

      // Epoch 1: no edits yet, open
      expect(loaded[1]!.edits).toHaveLength(0);
      expect(loaded[1]!.boundary.tag).toBe("open");
    },
  );

  it("multi-channel independence through pipeline", async () => {
    const dbName = `test-integration-multi-${Math.random()}`;

    const { provider, docs } = mockSubdocProvider(["content", "comments"]);
    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });
    edits = Edits.create({
      subdocProvider: provider,
      document,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    store = await Store.create(dbName);

    await edits.start();

    // Edit content channel
    docs.get("content")!.getArray("data").push(["content-edit"]);

    // Edit comments channel
    docs.get("comments")!.getArray("data").push(["comment-edit"]);

    // Persist all edits
    const contentCh = document.channel("content");
    const commentsCh = document.channel("comments");
    const doc = store.documents.get(TEST_DOC);
    for (const e of toArray(contentCh.tree).flatMap((ep) => ep.edits)) {
      await doc.history("content").append(0, e);
    }
    for (const e of toArray(commentsCh.tree).flatMap((ep) => ep.edits)) {
      await doc.history("comments").append(0, e);
    }

    // Close only content
    contentCh.closeEpoch();
    await doc.history("content").close(0, toArray(contentCh.tree)[0]!.boundary);

    // Verify independent persistence
    const loadedContent = await doc.history("content").load();
    const loadedComments = await doc.history("comments").load();

    expect(loadedContent).toHaveLength(2);
    expect(loadedContent[0]!.boundary.tag).toBe("closed");

    expect(loadedComments).toHaveLength(1);
    expect(loadedComments[0]!.boundary.tag).toBe("open");
    expect(loadedComments[0]!.edits).toHaveLength(1);
  });

  it("edits after convergence go to new epoch", async () => {
    const dbName = `test-integration-post-${Math.random()}`;

    const { provider, docs } = mockSubdocProvider(["content"]);
    document = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });
    edits = Edits.create({
      subdocProvider: provider,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    store = await Store.create(dbName);

    await edits.start();

    // Edit before convergence
    docs.get("content")!.getArray("data").push(["before"]);
    const ch = document.channel("content");

    // Persist epoch 0 edit
    const hist = store.documents.get(TEST_DOC).history("content");
    for (const e of toArray(ch.tree).flatMap((ep) => ep.edits)) {
      await hist.append(0, e);
    }

    // Converge
    ch.closeEpoch();
    await hist.close(0, toArray(ch.tree)[0]!.boundary);

    // Edit after convergence
    docs.get("content")!.getArray("data").push(["after"]);

    // Persist epoch 1 edit
    const epochs = toArray(ch.tree);
    const tipEdits = epochs[epochs.length - 1]!.edits;
    for (const e of tipEdits) {
      await hist.append(1, e);
    }

    // Load and verify
    const loaded = await hist.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.edits).toHaveLength(1);
    expect(loaded[0]!.boundary.tag).toBe("closed");
    expect(loaded[1]!.edits).toHaveLength(1);
    expect(loaded[1]!.boundary.tag).toBe("open");
  });

  it(
    "hydration: persist -> destroy -> load " +
      "-> rebuild channel -> views produce " +
      "correct values",
    async () => {
      const dbName = `test-hydration-${Math.random()}`;

      // --- Session 1: create edits + converge ---
      const { provider, docs } = mockSubdocProvider(["content"]);
      document = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec: fakeCodec(),
      });
      edits = Edits.create({
        subdocProvider: provider,
        document,
        channelNames: ["content"],
        localAuthor: "aabb",
      });
      store = await Store.create(dbName);

      await edits.start();

      // Two local edits
      docs.get("content")!.getArray("data").push(["first"]);
      docs.get("content")!.getArray("data").push(["second"]);

      const ch = document.channel("content");

      // Persist edits
      const hist = store.documents.get(TEST_DOC).history("content");
      for (const e of toArray(ch.tree).flatMap((ep) => ep.edits)) {
        await hist.append(0, e);
      }

      // Converge
      ch.closeEpoch();
      await hist.close(0, toArray(ch.tree)[0]!.boundary);

      // One more edit in new epoch
      docs.get("content")!.getArray("data").push(["third"]);

      const tipEdits = toArray(ch.tree).at(-1)!.edits;
      for (const e of tipEdits) {
        await hist.append(1, e);
      }

      // Capture expected tree measure
      const originalMeasure = measureTree(epochMeasured, ch.tree);

      // --- Destroy everything (simulate browser
      //     close) ---
      edits.destroy();
      document.destroy();
      store.close();

      // --- Session 2: load from store, rebuild ---
      const store2 = await Store.create(dbName);
      const loaded = await store2.documents
        .get(TEST_DOC)
        .history("content")
        .load();

      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.edits).toHaveLength(2);
      expect(loaded[0]!.boundary.tag).toBe("closed");
      expect(loaded[1]!.edits).toHaveLength(1);
      expect(loaded[1]!.boundary.tag).toBe("open");

      // Rebuild tree from loaded epochs
      const restoredTree = fromEpochs(loaded);

      // Verify tree measure matches
      const restoredMeasure = measureTree(epochMeasured, restoredTree);
      expect(restoredMeasure.epochCount).toBe(originalMeasure.epochCount);
      expect(restoredMeasure.editCount).toBe(originalMeasure.editCount);

      // Create new Document, populate channel via
      // appendEdit on loaded edits
      const doc2 = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec: fakeCodec(),
      });

      const ch2 = doc2.channel("content");

      // Activate contentHash view
      const hashFeed = ch2.activate(Fingerprint.view());

      // Rebuild channel by replaying loaded epochs
      // into the channel (appendEdit + closeEpoch)
      for (const loadedEpoch of loaded) {
        for (const e of loadedEpoch.edits) {
          ch2.appendEdit(e);
        }
        if (loadedEpoch.boundary.tag !== "open") {
          ch2.closeEpoch();
        }
      }

      // Verify channel tree matches loaded data
      const rebuilt = toArray(ch2.tree);
      expect(rebuilt).toHaveLength(2);
      expect(rebuilt[0]!.edits).toHaveLength(2);
      expect(rebuilt[0]!.boundary.tag).toBe("closed");
      expect(rebuilt[1]!.edits).toHaveLength(1);

      // Verify view produces non-zero hash
      // (3 edits with payloads)
      const hashState = hashFeed.getSnapshot();
      expect(hashState.tag).toBe("ready");
      if (hashState.tag === "ready") {
        expect(hashState.value).toBeInstanceOf(Uint8Array);
        const allZero = hashState.value.every((b: number) => b === 0);
        expect(allZero).toBe(false);
      }

      doc2.destroy();
      store2.close();

      // Prevent afterEach from double-destroying
      store = undefined as unknown as Store;
      document = undefined as unknown as DocumentType;
      edits = undefined as unknown as EditsType;
    },
  );
});
