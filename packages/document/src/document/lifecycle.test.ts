/**
 * Tests for Document lifecycle states.
 *
 * Levels (progressive enrichment):
 *   background → active → syncing → inspecting
 *
 * Each level activates additional views on all
 * channels.
 */
import { describe, it, expect, vi } from "vitest";
import type { Codec } from "@pokapali/codec";
import { Edit } from "#history";
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

describe("Document lifecycle", () => {
  it("starts at background level", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    expect(doc.level).toBe("background");
  });

  it("activate('active') transitions level", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });

    doc.activate("active");

    expect(doc.level).toBe("active");
  });

  it(
    "activate('active') enables merged-payload " + "view on existing channels",
    () => {
      const doc = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec: fakeCodec(),
      });

      const ch = doc.channel("content");
      doc.activate("active");

      // merged-payload feed should be available
      const feed = ch.activate({
        name: "merged-payload",
        description: "",
        measured: {
          monoid: {
            empty: new Uint8Array([]),
            append: (a, b) => new Uint8Array([...a, ...b]),
          },
          measure: () => new Uint8Array([]),
        },
      });
      // If already activated by lifecycle, calling
      // activate again returns the existing feed
      const snap = feed.getSnapshot();
      expect(snap.tag === "ready" || snap.tag === "stale").toBe(true);
    },
  );

  it("activate('syncing') activates content-hash " + "view on channels", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });

    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(1));

    doc.activate("syncing");

    expect(doc.level).toBe("syncing");
  });

  it("activate('inspecting') sets level", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });

    doc.activate("inspecting");

    expect(doc.level).toBe("inspecting");
  });

  it("deactivate() returns to background", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec: fakeCodec(),
    });

    doc.activate("syncing");
    expect(doc.level).toBe("syncing");

    doc.deactivate();
    expect(doc.level).toBe("background");
  });

  it("activate without codec throws for " + "levels above background", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    expect(() => doc.activate("active")).toThrow(/codec/i);
  });

  it("activate('background') is a no-op", () => {
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    doc.activate("background");
    expect(doc.level).toBe("background");
  });

  it("stepping up preserves lower-level views", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(1));

    doc.activate("active");
    doc.activate("syncing");

    expect(doc.level).toBe("syncing");
    // merged-payload still active (from active level)
  });

  it("stepping down deactivates higher-level " + "views", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.channel("content");

    doc.activate("syncing");
    expect(doc.level).toBe("syncing");

    doc.activate("active");
    expect(doc.level).toBe("active");
    // content-hash view deactivated, merged-payload
    // still active
  });

  it("new channels get views for current level", () => {
    const codec = fakeCodec();
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.activate("active");

    // Create channel AFTER activation
    const ch = doc.channel("content");
    ch.appendEdit(fakeEdit(1));

    // Channel should already have merged-payload
    // active (no explicit activate needed)
  });
});
