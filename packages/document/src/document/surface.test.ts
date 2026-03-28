/**
 * surface.test.ts — tests for Document.surface().
 *
 * Verifies the CodecSurface lifecycle: creation,
 * caching, local edit → appendEdit wiring,
 * remote appendEdit → surface.applyEdit sync,
 * and cleanup on destroy.
 */
import { describe, it, expect, vi } from "vitest";
import type { Codec, CodecSurface } from "@pokapali/codec";
import { measureTree, viewr } from "@pokapali/finger-tree";
import { Edit, epochMeasured } from "#history";
import { Document } from "./document.js";

// --- Helpers ---

function fakeIdentity() {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeCapability() {
  return {
    channels: new Set(["content"]),
    canPushSnapshots: false,
    isAdmin: false,
  };
}

/**
 * Mock CodecSurface with vitest spies and a way
 * to trigger the onLocalEdit callback externally.
 */
function fakeSurface(): CodecSurface & {
  fireLocalEdit: (payload: Uint8Array) => void;
} {
  let cb: ((p: Uint8Array) => void) | null = null;

  return {
    handle: { mockDoc: true },
    applyEdit: vi.fn(),
    applyState: vi.fn(),
    onLocalEdit: vi.fn((fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    }),
    destroy: vi.fn(),
    fireLocalEdit(payload: Uint8Array) {
      if (cb) cb(payload);
    },
  };
}

function fakeCodecWithSurface(surface: ReturnType<typeof fakeSurface>): Codec {
  return {
    merge: (a, b) => new Uint8Array([...a, ...b]),
    diff: (state, base) => {
      const s = new Set(base);
      return new Uint8Array([...state].filter((x) => !s.has(x)));
    },
    apply: (base, update) => new Uint8Array([...base, ...update]),
    empty: () => new Uint8Array([]),
    contains: () => false,
    createSurface: vi.fn(() => surface),
    clockSum: () => 0,
  };
}

function syncEdit(id: number, channel = "content"): Edit {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp: Date.now(),
    author: "peer-1",
    channel,
    origin: "sync",
    signature: new Uint8Array([id]),
  });
}

// --- Tests ---

describe("Document.surface", () => {
  it("creates a CodecSurface via codec", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    const s = doc.surface("content");
    expect(s).toBe(surface);
    expect(codec.createSurface).toHaveBeenCalled();
  });

  it("caches surface per channel", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    const s1 = doc.surface("content");
    const s2 = doc.surface("content");
    expect(s1).toBe(s2);
    expect(codec.createSurface).toHaveBeenCalledTimes(1);
  });

  it("wires onLocalEdit → Edit → appendEdit", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.surface("content");
    expect(surface.onLocalEdit).toHaveBeenCalled();

    // Simulate local edit on the surface
    const payload = new Uint8Array([42]);
    surface.fireLocalEdit(payload);

    // Check the channel's tree has the edit
    const ch = doc.channel("content");
    const summary = measureTree(epochMeasured, ch.tree);
    expect(summary.editCount).toBe(1);

    // Verify the edit payload matches
    const tip = viewr(epochMeasured, ch.tree);
    expect(tip).not.toBeNull();
    expect(tip!.last.edits[0]!.payload).toEqual(payload);
    expect(tip!.last.edits[0]!.origin).toBe("local");
  });

  it("remote appendEdit syncs to surface", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.surface("content");
    const ch = doc.channel("content");

    // Append a remote edit
    const edit = syncEdit(99);
    ch.appendEdit(edit);

    // Surface should have received applyEdit
    expect(surface.applyEdit).toHaveBeenCalledWith(edit.payload);
  });

  it("local appendEdit does not double-apply " + "to surface", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.surface("content");

    // Simulate local edit from surface
    surface.fireLocalEdit(new Uint8Array([1]));

    // applyEdit should NOT be called — the edit
    // already originated from the surface
    expect(surface.applyEdit).not.toHaveBeenCalled();
  });

  it("destroy cleans up surfaces", () => {
    const surface = fakeSurface();
    const codec = fakeCodecWithSurface(surface);
    const doc = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
      codec,
    });

    doc.surface("content");
    doc.destroy();

    expect(surface.destroy).toHaveBeenCalled();
  });
});
