/**
 * Round-trip integration test proving:
 * materialize (fold) → apply (appendSnapshot) →
 * fold again → identical output.
 *
 * Exercises the two paths that B2 makes primary:
 * publish uses foldTree to materialize, remote apply
 * uses Document.channel.appendSnapshot to ingest.
 */
import { describe, it, expect } from "vitest";
import { Document, Edit, State, Cache, foldTree } from "@pokapali/document";
import { yjsCodec } from "@pokapali/codec";
import * as Y from "yjs";

function fakeIdentity() {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeCapability(channels: string[]) {
  return {
    channels: new Set(channels),
    canPushSnapshots: false,
    isAdmin: false,
  };
}

function makeYjsEdit(channel: string, fn: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  fn(doc);
  return Y.encodeStateAsUpdate(doc);
}

describe("snapshot round-trip", () => {
  it("fold → appendSnapshot → fold" + " produces identical state", () => {
    const channels = ["content"];

    // 1. Create source document with edits
    const src = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(channels),
      codec: yjsCodec,
    });

    const srcCh = src.channel("content");
    srcCh.appendEdit(
      Edit.create({
        payload: makeYjsEdit("content", (doc) => {
          doc.getText("t").insert(0, "hello");
        }),
        timestamp: 1000,
        author: "aabb",
        channel: "content",
        origin: "local",
        signature: new Uint8Array(),
      }),
    );
    srcCh.appendEdit(
      Edit.create({
        payload: makeYjsEdit("content", (doc) => {
          doc.getText("t").insert(0, " world");
        }),
        timestamp: 2000,
        author: "aabb",
        channel: "content",
        origin: "local",
        signature: new Uint8Array(),
      }),
    );

    // 2. Materialize snapshot via fold (publish path)
    const measured = State.channelMeasured(yjsCodec);
    const cache1 = Cache.create<Uint8Array>();
    const snapshot = foldTree<Uint8Array>(measured, srcCh.tree, cache1);

    // Sanity: snapshot is non-empty
    expect(snapshot.length).toBeGreaterThan(0);

    // 3. Create fresh document (simulates remote peer)
    const dst = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(channels),
      codec: yjsCodec,
    });

    // 4. Apply snapshot via appendSnapshot (remote path)
    const dstCh = dst.channel("content");
    dstCh.appendSnapshot(snapshot);

    // 5. Fold the destination tree
    const cache2 = Cache.create<Uint8Array>();
    const roundTripped = foldTree<Uint8Array>(measured, dstCh.tree, cache2);

    // 6. Verify identical CRDT state
    expect(roundTripped).toEqual(snapshot);

    // 7. Verify content is correct by decoding
    const doc = new Y.Doc();
    Y.applyUpdate(doc, roundTripped);
    const text = doc.getText("t").toString();
    expect(text).toContain("hello");
    expect(text).toContain("world");
  });

  it("multi-channel round-trip preserves" + " all channels", () => {
    const channels = ["content", "comments"];

    const src = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(channels),
      codec: yjsCodec,
    });

    // Add edits to both channels
    src.channel("content").appendEdit(
      Edit.create({
        payload: makeYjsEdit("content", (doc) => {
          doc.getText("body").insert(0, "article");
        }),
        timestamp: 1000,
        author: "aabb",
        channel: "content",
        origin: "local",
        signature: new Uint8Array(),
      }),
    );
    src.channel("comments").appendEdit(
      Edit.create({
        payload: makeYjsEdit("comments", (doc) => {
          doc.getArray("list").push(["comment-1"]);
        }),
        timestamp: 2000,
        author: "aabb",
        channel: "comments",
        origin: "local",
        signature: new Uint8Array(),
      }),
    );

    // Materialize both channels (publish path)
    const measured = State.channelMeasured(yjsCodec);
    const snapshots: Record<string, Uint8Array> = {};
    for (const ch of channels) {
      const cache = Cache.create<Uint8Array>();
      snapshots[ch] = foldTree<Uint8Array>(
        measured,
        src.channel(ch).tree,
        cache,
      );
    }

    // Apply to fresh document (remote path)
    const dst = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(channels),
      codec: yjsCodec,
    });
    for (const [ch, state] of Object.entries(snapshots)) {
      dst.channel(ch).appendSnapshot(state);
    }

    // Fold destination and compare
    for (const ch of channels) {
      const cache = Cache.create<Uint8Array>();
      const result = foldTree<Uint8Array>(
        measured,
        dst.channel(ch).tree,
        cache,
      );
      expect(result).toEqual(snapshots[ch]);
    }

    // Verify content channel
    const contentDoc = new Y.Doc();
    Y.applyUpdate(contentDoc, snapshots["content"]!);
    expect(contentDoc.getText("body").toString()).toBe("article");

    // Verify comments channel
    const commentsDoc = new Y.Doc();
    Y.applyUpdate(commentsDoc, snapshots["comments"]!);
    expect(commentsDoc.getArray("list").toArray()).toEqual(["comment-1"]);
  });
});
