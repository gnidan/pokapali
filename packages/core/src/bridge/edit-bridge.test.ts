import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import { SNAPSHOT_ORIGIN } from "@pokapali/subdocs";
import type { SubdocManager } from "@pokapali/subdocs";
import { createDocument } from "../document/document.js";
import type { Document } from "../document/document.js";
import { createEditBridge } from "./edit-bridge.js";

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

/**
 * Create a mock SubdocManager with real Y.Docs
 * per channel. whenLoaded resolves immediately
 * unless overridden.
 */
function mockSubdocManager(
  channelNames: string[],
  opts?: { whenLoaded?: Promise<void> },
): {
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
    whenLoaded: opts?.whenLoaded ?? Promise.resolve(),
    destroy() {},
  };

  return { manager, docs };
}

// -- Tests --

describe("createEditBridge", () => {
  let doc: Document;

  beforeEach(() => {
    doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
  });

  it("captures local edit", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Simulate a local Y.Doc update (null origin)
    const yDoc = docs.get("content")!;
    yDoc.getArray("data").push([1]);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const edits = epochs.flatMap((ep) => ep.edits);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.origin).toBe("local");
    expect(edits[0]!.author).toBe("aabb");
    expect(edits[0]!.channel).toBe("content");
  });

  it("captures remote edit with sync origin", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Simulate a remote update (non-null origin)
    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([42]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, "some-provider");

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const edits = epochs.flatMap((ep) => ep.edits);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.origin).toBe("sync");
    expect(edits[0]!.author).toBe("");
  });

  it("filters SNAPSHOT_ORIGIN updates", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Apply update with SNAPSHOT_ORIGIN
    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([1]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, SNAPSHOT_ORIGIN);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const edits = epochs.flatMap((ep) => ep.edits);

    expect(edits).toHaveLength(0);
  });

  it("filters skipOrigins updates", async () => {
    const customOrigin = { name: "y-indexeddb" };
    const { manager, docs } = mockSubdocManager(["content"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
      skipOrigins: new Set([customOrigin]),
    });
    await bridge.start();

    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([1]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, customOrigin);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const edits = epochs.flatMap((ep) => ep.edits);

    expect(edits).toHaveLength(0);
  });

  it("routes edits to correct channels", async () => {
    const { manager, docs } = mockSubdocManager(["content", "comments"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Edit in content
    docs.get("content")!.getArray("data").push([1]);
    // Edit in comments
    docs.get("comments")!.getArray("data").push([2]);

    const contentEdits = toArray(doc.channel("content").tree).flatMap(
      (ep) => ep.edits,
    );
    const commentsEdits = toArray(doc.channel("comments").tree).flatMap(
      (ep) => ep.edits,
    );

    expect(contentEdits).toHaveLength(1);
    expect(contentEdits[0]!.channel).toBe("content");
    expect(commentsEdits).toHaveLength(1);
    expect(commentsEdits[0]!.channel).toBe("comments");
  });

  it("destroy stops capturing edits", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    bridge.destroy();

    docs.get("content")!.getArray("data").push([1]);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const edits = epochs.flatMap((ep) => ep.edits);

    expect(edits).toHaveLength(0);
  });

  it("start waits for whenLoaded", async () => {
    let resolveLoaded!: () => void;
    const whenLoaded = new Promise<void>((r) => (resolveLoaded = r));

    const { manager, docs } = mockSubdocManager(["content"], { whenLoaded });

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });

    const startPromise = bridge.start();
    expect(bridge.started).toBe(false);

    // Edits before whenLoaded should not be captured
    docs.get("content")!.getArray("data").push([1]);

    let ch = doc.channel("content");
    let edits = toArray(ch.tree).flatMap((ep) => ep.edits);
    expect(edits).toHaveLength(0);

    // Resolve whenLoaded
    resolveLoaded();
    await startPromise;
    expect(bridge.started).toBe(true);

    // Now edits should be captured
    docs.get("content")!.getArray("data").push([2]);
    ch = doc.channel("content");
    edits = toArray(ch.tree).flatMap((ep) => ep.edits);
    expect(edits).toHaveLength(1);
  });
});
