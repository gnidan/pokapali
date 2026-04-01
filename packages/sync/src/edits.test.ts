import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import { SNAPSHOT_ORIGIN } from "./subdoc-provider.js";
import type { SubdocProvider } from "./subdoc-provider.js";
import { Document } from "@pokapali/document";
import type { Document as DocumentType } from "@pokapali/document";
import { Edits } from "./edits.js";

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

/**
 * Create a mock SubdocProvider with real Y.Docs
 * per channel. whenLoaded resolves immediately
 * unless overridden.
 */
function mockSubdocProvider(
  channelNames: string[],
  opts?: { whenLoaded?: Promise<void> },
): {
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
    whenLoaded: opts?.whenLoaded ?? Promise.resolve(),
  };

  return { provider, docs };
}

// -- Tests --

describe("Edits.create", () => {
  let doc: DocumentType;

  beforeEach(() => {
    doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });
  });

  it("captures local edit", async () => {
    const { provider, docs } = mockSubdocProvider(["content"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Simulate a local Y.Doc update (null origin)
    const yDoc = docs.get("content")!;
    yDoc.getArray("data").push([1]);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const editList = epochs.flatMap((ep) => ep.edits);

    expect(editList).toHaveLength(1);
    expect(editList[0]!.origin).toBe("local");
    expect(editList[0]!.author).toBe("aabb");
    expect(editList[0]!.channel).toBe("content");
  });

  it("captures remote edit with sync origin", async () => {
    const { provider, docs } = mockSubdocProvider(["content"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Simulate a remote update (non-null origin)
    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([42]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, "some-provider");

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const editList = epochs.flatMap((ep) => ep.edits);

    expect(editList).toHaveLength(1);
    expect(editList[0]!.origin).toBe("sync");
    expect(editList[0]!.author).toBe("");
  });

  it("filters SNAPSHOT_ORIGIN updates", async () => {
    const { provider, docs } = mockSubdocProvider(["content"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    // Apply update with SNAPSHOT_ORIGIN
    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([1]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, SNAPSHOT_ORIGIN);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const editList = epochs.flatMap((ep) => ep.edits);

    expect(editList).toHaveLength(0);
  });

  it("filters skipOrigins updates", async () => {
    const customOrigin = { name: "y-indexeddb" };
    const { provider, docs } = mockSubdocProvider(["content"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
      skipOrigins: new Set([customOrigin]),
    });
    await edits.start();

    const yDoc = docs.get("content")!;
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push([1]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, customOrigin);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const editList = epochs.flatMap((ep) => ep.edits);

    expect(editList).toHaveLength(0);
  });

  it("routes edits to correct channels", async () => {
    const { provider, docs } = mockSubdocProvider(["content", "comments"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    await edits.start();

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
    const { provider, docs } = mockSubdocProvider(["content"]);

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await edits.start();

    edits.destroy();

    docs.get("content")!.getArray("data").push([1]);

    const ch = doc.channel("content");
    const epochs = toArray(ch.tree);
    const editList = epochs.flatMap((ep) => ep.edits);

    expect(editList).toHaveLength(0);
  });

  it("destroy during pending whenLoaded " + "prevents attach", async () => {
    let resolveLoaded!: () => void;
    const whenLoaded = new Promise<void>((r) => (resolveLoaded = r));

    const { provider, docs } = mockSubdocProvider(["content"], { whenLoaded });

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });

    const startPromise = edits.start();

    // Destroy before whenLoaded resolves
    edits.destroy();

    // Now resolve whenLoaded
    resolveLoaded();
    await startPromise;

    // Edits should NOT have started
    expect(edits.started).toBe(false);

    // Edits should not be captured
    docs.get("content")!.getArray("data").push([1]);

    const ch = doc.channel("content");
    const editList = toArray(ch.tree).flatMap((ep) => ep.edits);
    expect(editList).toHaveLength(0);
  });

  it("start waits for whenLoaded", async () => {
    let resolveLoaded!: () => void;
    const whenLoaded = new Promise<void>((r) => (resolveLoaded = r));

    const { provider, docs } = mockSubdocProvider(["content"], { whenLoaded });

    const edits = Edits.create({
      subdocProvider: provider,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });

    const startPromise = edits.start();
    expect(edits.started).toBe(false);

    // Edits before whenLoaded should not be captured
    docs.get("content")!.getArray("data").push([1]);

    let ch = doc.channel("content");
    let editList = toArray(ch.tree).flatMap((ep) => ep.edits);
    expect(editList).toHaveLength(0);

    // Resolve whenLoaded
    resolveLoaded();
    await startPromise;
    expect(edits.started).toBe(true);

    // Now edits should be captured
    docs.get("content")!.getArray("data").push([2]);
    ch = doc.channel("content");
    editList = toArray(ch.tree).flatMap((ep) => ep.edits);
    expect(editList).toHaveLength(1);
  });
});
