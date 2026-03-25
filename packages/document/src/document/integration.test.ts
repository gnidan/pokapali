/**
 * End-to-end integration test: history → views →
 * channels → document.
 */
import { describe, it, expect, vi } from "vitest";
import { measureTree, toArray } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import { epochMeasured, Edit } from "#history";
import * as State from "#state";
import * as Fingerprint from "#fingerprint";
import { Document } from "./document.js";

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

function fakeEdit(id: number, channel = "content") {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp: id,
    author: "aabb",
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

function fakeCodec(): Codec {
  return {
    merge: (a, b) => {
      const combined = new Uint8Array([...a, ...b]);
      combined.sort();
      return combined;
    },
    diff: (state, base) => {
      const baseSet = new Set(base);
      return new Uint8Array([...state].filter((b) => !baseSet.has(b)));
    },
    apply: (base, update) => {
      const combined = new Uint8Array([...base, ...update]);
      combined.sort();
      return combined;
    },
    empty: () => new Uint8Array([]),
    contains: (snapshot, editPayload) => {
      const id = editPayload[0]!;
      for (const b of snapshot) {
        if (b === id) return true;
      }
      return false;
    },
  };
}

// -- Integration test --

describe("Document e2e integration", () => {
  it("full lifecycle: channels, edits, views, epochs", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const content = doc.channel("content");
    const comments = doc.channel("comments");

    const mergeView = State.view(codec);
    const hashView = Fingerprint.view();

    const contentMergeFeed = content.activate(mergeView);
    const contentHashFeed = content.activate(hashView);
    const commentsMergeFeed = comments.activate(mergeView);

    // Initial state — empty
    let contentMerge = contentMergeFeed.getSnapshot();
    expect(contentMerge.tag).toBe("ready");
    if (contentMerge.tag === "ready") {
      expect(contentMerge.value).toEqual(new Uint8Array([]));
    }

    let commentsMerge = commentsMergeFeed.getSnapshot();
    expect(commentsMerge.tag).toBe("ready");
    if (commentsMerge.tag === "ready") {
      expect(commentsMerge.value).toEqual(new Uint8Array([]));
    }

    // Append edits to content channel
    content.appendEdit(fakeEdit(1, "content"));
    content.appendEdit(fakeEdit(2, "content"));

    contentMerge = contentMergeFeed.getSnapshot();
    expect(contentMerge.tag).toBe("ready");
    if (contentMerge.tag === "ready") {
      expect(contentMerge.value).toEqual(new Uint8Array([1, 2]));
    }

    // Channel independence
    commentsMerge = commentsMergeFeed.getSnapshot();
    expect(commentsMerge.tag).toBe("ready");
    if (commentsMerge.tag === "ready") {
      expect(commentsMerge.value).toEqual(new Uint8Array([]));
    }

    // Append to comments
    comments.appendEdit(fakeEdit(10, "comments"));

    commentsMerge = commentsMergeFeed.getSnapshot();
    expect(commentsMerge.tag).toBe("ready");
    if (commentsMerge.tag === "ready") {
      expect(commentsMerge.value).toEqual(new Uint8Array([10]));
    }

    // Content unchanged
    contentMerge = contentMergeFeed.getSnapshot();
    if (contentMerge.tag === "ready") {
      expect(contentMerge.value).toEqual(new Uint8Array([1, 2]));
    }

    // Close content epoch, append more
    content.closeEpoch();
    content.appendEdit(fakeEdit(3, "content"));

    contentMerge = contentMergeFeed.getSnapshot();
    expect(contentMerge.tag).toBe("ready");
    if (contentMerge.tag === "ready") {
      expect(contentMerge.value).toEqual(new Uint8Array([1, 2, 3]));
    }

    // Verify epoch structure
    const contentEpochs = toArray(content.tree);
    expect(contentEpochs).toHaveLength(2);
    expect(contentEpochs[0]!.boundary.tag).toBe("closed");
    expect(contentEpochs[0]!.edits).toHaveLength(2);
    expect(contentEpochs[1]!.boundary.tag).toBe("open");
    expect(contentEpochs[1]!.edits).toHaveLength(1);

    const commentsEpochs = toArray(comments.tree);
    expect(commentsEpochs).toHaveLength(1);
    expect(commentsEpochs[0]!.boundary.tag).toBe("open");
    expect(commentsEpochs[0]!.edits).toHaveLength(1);

    // Verify Summary per channel
    const contentIndex = measureTree(epochMeasured, content.tree);
    expect(contentIndex.epochCount).toBe(2);
    expect(contentIndex.editCount).toBe(3);

    const commentsIndex = measureTree(epochMeasured, comments.tree);
    expect(commentsIndex.epochCount).toBe(1);
    expect(commentsIndex.editCount).toBe(1);

    // contentHash is non-zero after edits
    const hashState = contentHashFeed.getSnapshot();
    expect(hashState.tag).toBe("ready");
    if (hashState.tag === "ready") {
      const allZero = hashState.value.every((b) => b === 0);
      expect(allZero).toBe(false);
    }
  });

  it("feed stale→ready transitions on update", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch = doc.channel("content");
    const feed = ch.activate(State.view(codec));

    const snapshots: string[] = [];
    feed.subscribe(() => {
      snapshots.push(feed.getSnapshot().tag);
    });

    ch.appendEdit(fakeEdit(1));

    expect(snapshots).toEqual(["stale", "ready"]);
  });

  it("identity and capability accessible", () => {
    const identity = fakeIdentity();
    const capability = fakeCapability();
    const doc = Document.create({
      identity,
      capability,
    });

    expect(doc.identity).toBe(identity);
    expect(doc.capability).toBe(capability);
    expect(doc.capability.channels).toContain("content");
  });

  it("destroy stops all channel updates", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const content = doc.channel("content");
    const comments = doc.channel("comments");
    const contentFeed = content.activate(State.view(codec));
    const commentsFeed = comments.activate(State.view(codec));

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    contentFeed.subscribe(cb1);
    commentsFeed.subscribe(cb2);

    doc.destroy();

    content.appendEdit(fakeEdit(1));
    comments.appendEdit(fakeEdit(2));

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
