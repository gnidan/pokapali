/**
 * Tests for Document view activation lifecycle.
 *
 * Document.activate(view) registers a monoidal view,
 * delegates per-channel evaluation, and combines
 * results. Document.deactivate(viewName) removes it.
 */
import { describe, it, expect, vi } from "vitest";
import type { Codec } from "@pokapali/codec";
import { Edit } from "#history";
import * as State from "../state/index.js";
import * as Fingerprint from "../fingerprint/index.js";
import { Document } from "./document.js";
import { inspect } from "../inspect.js";

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
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
    },
  };
}

function fakeEdit(id: number, channel = "content") {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp: Date.now(),
    author: "aabb",
    channel,
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

// -- Tests --

describe("Document view activation", () => {
  it("activate returns a feed with ready status", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const feed = doc.activate(State.view(codec));
    const snap = feed.getSnapshot();

    expect(snap.tag).toBe("ready");
    doc.destroy();
  });

  it(
    "activate is idempotent — same view returns " + "same feed behavior",
    () => {
      const codec = fakeCodec();
      const doc = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
      });

      const feed1 = doc.activate(State.view(codec));
      const feed2 = doc.activate(State.view(codec));

      expect(feed1.getSnapshot()).toBe(feed2.getSnapshot());
      doc.destroy();
    },
  );

  it("deactivate removes the view", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const feed = doc.activate(State.view(codec));
    expect(feed.getSnapshot().tag).toBe("ready");

    doc.deactivate("merged-payload");

    // Re-activating creates a fresh feed
    const feed2 = doc.activate(State.view(codec));
    expect(feed2.getSnapshot().tag).toBe("ready");
    doc.destroy();
  });

  it("feed reflects edits on the channel", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    doc.activate(State.view(codec));
    const ch = doc.channel("content");

    ch.appendEdit(fakeEdit(42));

    const feed = doc.activate(State.view(codec));
    const snap = feed.getSnapshot();
    expect(snap.tag).toBe("ready");
    if (snap.tag === "ready") {
      expect(snap.value).toEqual(new Uint8Array([42]));
    }

    doc.destroy();
  });

  it("feed notifies subscribers on tree change", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const feed = doc.activate(State.view(codec));
    const cb = vi.fn();
    feed.subscribe(cb);

    doc.channel("content").appendEdit(fakeEdit(1));

    expect(cb).toHaveBeenCalled();
    doc.destroy();
  });

  it("multi-channel view combines per-channel " + "results", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch1 = doc.channel("content");
    const ch2 = doc.channel("comments");
    ch1.appendEdit(fakeEdit(1, "content"));
    ch2.appendEdit(fakeEdit(2, "comments"));

    const feed = doc.activate(Fingerprint.view());
    const snap = feed.getSnapshot();

    expect(snap.tag).toBe("ready");
    if (snap.tag === "ready") {
      // Fingerprint XORs SHA-256 hashes across
      // channels — result should be non-zero
      expect(snap.value.length).toBe(32);
      const allZero = snap.value.every((b) => b === 0);
      expect(allZero).toBe(false);
    }

    doc.destroy();
  });

  it("new channel created after activation gets " + "views", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    // Activate state view before creating channel
    const feed = doc.activate(State.view(codec));

    // Create channel after activation
    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(5));

    const snap = feed.getSnapshot();
    expect(snap.tag).toBe("ready");
    if (snap.tag === "ready") {
      expect(snap.value).toEqual(new Uint8Array([5]));
    }

    doc.destroy();
  });

  it("deactivate is a no-op for unknown views", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    expect(() => doc.deactivate("nonexistent")).not.toThrow();
    doc.destroy();
  });

  it("destroy cleans up all active views", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const feed = doc.activate(State.view(codec));
    const cb = vi.fn();
    feed.subscribe(cb);

    doc.destroy();

    // After destroy, no more notifications
    // (can't easily test this without channel
    //  access, but at least no throw)
  });

  it("deprecated deactivate() with no args " + "removes all views", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(1));

    const stateFeed = doc.activate(State.view(codec));
    const fpFeed = doc.activate(Fingerprint.view());

    expect(stateFeed.getSnapshot().tag).toBe("ready");
    expect(fpFeed.getSnapshot().tag).toBe("ready");

    // Deprecated: deactivate all
    doc.deactivate();

    // Re-activating produces fresh feeds
    const stateFeed2 = doc.activate(State.view(codec));
    expect(stateFeed2.getSnapshot()).not.toBe(stateFeed.getSnapshot());

    doc.destroy();
  });
});

describe("inspect (one-shot evaluation)", () => {
  it("returns combined value for single-channel " + "view", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(10));
    ch.appendEdit(fakeEdit(20));

    const result = inspect(State.view(codec), doc);
    expect(result).toEqual(new Uint8Array([10, 20]));

    doc.destroy();
  });

  it("returns combined value for multi-channel " + "view", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch1 = doc.channel("content");
    const ch2 = doc.channel("comments");
    ch1.appendEdit(fakeEdit(1, "content"));
    ch2.appendEdit(fakeEdit(2, "comments"));

    const result = inspect(Fingerprint.view(), doc);

    // SHA-256 + XOR of both channels
    expect(result.length).toBe(32);
    const allZero = result.every((b) => b === 0);
    expect(allZero).toBe(false);

    doc.destroy();
  });

  it("inspect does not require prior activation", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    doc.channel("content").appendEdit(fakeEdit(7));

    // inspect works without activate
    const result = inspect(State.view(codec), doc);
    expect(result).toEqual(new Uint8Array([7]));

    doc.destroy();
  });

  it("inspect result matches activated feed " + "snapshot", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    doc.channel("content").appendEdit(fakeEdit(3));

    const feed = doc.activate(State.view(codec));
    const snap = feed.getSnapshot();
    const oneShot = inspect(State.view(codec), doc);

    expect(snap.tag).toBe("ready");
    if (snap.tag === "ready") {
      expect(snap.value).toEqual(oneShot);
    }

    doc.destroy();
  });
});
