/**
 * Integration test — proves the full Phase 4b
 * pipeline composes:
 *
 * SubdocManager → EditBridge → Document → EpochStore
 *
 * ConvergenceDetector is mocked (direct closeEpoch
 * call) to keep the test deterministic.
 */
import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import { createDocument } from "../document/document.js";
import type { Document } from "../document/document.js";
import { createEditBridge } from "./edit-bridge.js";
import type { EditBridge } from "./edit-bridge.js";
import { createEpochStore } from "./epoch-store.js";
import type { EpochStore } from "./epoch-store.js";

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

// -- Tests --

describe("Phase 4b bridge integration", () => {
  let document: Document;
  let bridge: EditBridge;
  let store: EpochStore;

  afterEach(() => {
    bridge?.destroy();
    document?.destroy();
    store?.destroy();
  });

  it(
    "full pipeline: edit → channel → persist " + "→ converge → load round-trip",
    async () => {
      const dbName = `test-integration-${Math.random()}`;

      // 1. Create all components
      const { manager, docs } = mockSubdocManager(["content"]);
      document = createDocument({
        identity: fakeIdentity(),
        capability: fakeCapability(),
      });
      bridge = createEditBridge({
        subdocManager: manager,
        document,
        channelNames: ["content"],
        localAuthor: "aabb",
      });
      store = await createEpochStore(dbName);

      // 2. Start EditBridge
      await bridge.start();

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
      for (const e of epochs[0]!.edits) {
        await store.persistEdit("content", e);
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
      await store.persistEdit("content", remoteEdits[0]!);

      // 6. Simulate convergence (mock — direct
      //    closeEpoch instead of ConvergenceDetector)
      ch.closeEpoch();

      // Verify epoch closed in channel tree
      epochs = toArray(ch.tree);
      expect(epochs).toHaveLength(2);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      expect(epochs[1]!.boundary.tag).toBe("open");

      // Persist epoch boundary
      await store.persistEpochBoundary("content", 0, epochs[0]!.boundary);

      // 7. Load from EpochStore — verify round-trip
      const loaded = await store.loadChannelEpochs("content");
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

    const { manager, docs } = mockSubdocManager(["content", "comments"]);
    document = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    bridge = createEditBridge({
      subdocManager: manager,
      document,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    store = await createEpochStore(dbName);

    await bridge.start();

    // Edit content channel
    docs.get("content")!.getArray("data").push(["content-edit"]);

    // Edit comments channel
    docs.get("comments")!.getArray("data").push(["comment-edit"]);

    // Persist all edits
    const contentCh = document.channel("content");
    const commentsCh = document.channel("comments");
    for (const e of toArray(contentCh.tree).flatMap((ep) => ep.edits)) {
      await store.persistEdit("content", e);
    }
    for (const e of toArray(commentsCh.tree).flatMap((ep) => ep.edits)) {
      await store.persistEdit("comments", e);
    }

    // Close only content
    contentCh.closeEpoch();
    await store.persistEpochBoundary(
      "content",
      0,
      toArray(contentCh.tree)[0]!.boundary,
    );

    // Verify independent persistence
    const loadedContent = await store.loadChannelEpochs("content");
    const loadedComments = await store.loadChannelEpochs("comments");

    expect(loadedContent).toHaveLength(2);
    expect(loadedContent[0]!.boundary.tag).toBe("closed");

    expect(loadedComments).toHaveLength(1);
    expect(loadedComments[0]!.boundary.tag).toBe("open");
    expect(loadedComments[0]!.edits).toHaveLength(1);
  });

  it("edits after convergence go to new epoch", async () => {
    const dbName = `test-integration-post-${Math.random()}`;

    const { manager, docs } = mockSubdocManager(["content"]);
    document = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    bridge = createEditBridge({
      subdocManager: manager,
      document,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    store = await createEpochStore(dbName);

    await bridge.start();

    // Edit before convergence
    docs.get("content")!.getArray("data").push(["before"]);
    const ch = document.channel("content");

    // Persist epoch 0 edit
    for (const e of toArray(ch.tree).flatMap((ep) => ep.edits)) {
      await store.persistEdit("content", e);
    }

    // Converge
    ch.closeEpoch();
    await store.persistEpochBoundary(
      "content",
      0,
      toArray(ch.tree)[0]!.boundary,
    );

    // Edit after convergence
    docs.get("content")!.getArray("data").push(["after"]);

    // Persist epoch 1 edit
    const epochs = toArray(ch.tree);
    const tipEdits = epochs[epochs.length - 1]!.edits;
    for (const e of tipEdits) {
      await store.persistEdit("content", e);
    }

    // Load and verify
    const loaded = await store.loadChannelEpochs("content");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.edits).toHaveLength(1);
    expect(loaded[0]!.boundary.tag).toBe("closed");
    expect(loaded[1]!.edits).toHaveLength(1);
    expect(loaded[1]!.boundary.tag).toBe("open");
  });
});
