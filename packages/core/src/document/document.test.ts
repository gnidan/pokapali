import { describe, it, expect, vi } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { Capability } from "@pokapali/capability";
import type { Epoch } from "../epoch/types.js";
import { edit } from "../epoch/types.js";
import { monoidalView } from "../view/types.js";
import { createDocument } from "./document.js";

// -- Helpers --

function fakeIdentity(): Ed25519KeyPair {
  return {
    publicKey: new Uint8Array(32).fill(0xaa),
    privateKey: new Uint8Array(64).fill(0xbb),
  };
}

function fakeCapability(): Capability {
  return {
    channels: new Set(["content", "comments"]),
    canPushSnapshots: false,
    isAdmin: false,
  };
}

function fakeEdit(id: number) {
  return edit({
    payload: new Uint8Array([id]),
    timestamp: Date.now(),
    author: "aabb",
    channel: "content",
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

const editCountMeasured: Measured<number, Epoch> = {
  monoid: { empty: 0, append: (a, b) => a + b },
  measure: (ep) => ep.edits.length,
};

const editCountView = monoidalView({
  name: "edit-count",
  description: "Total edit count",
  measured: editCountMeasured,
});

// -- Tests --

describe("createDocument", () => {
  it("channel returns a Channel", () => {
    const doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch = doc.channel("content");
    expect(ch.name).toBe("content");
  });

  it("same name returns same Channel", () => {
    const doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const ch1 = doc.channel("content");
    const ch2 = doc.channel("content");
    expect(ch1).toBe(ch2);
  });

  it("different names return different Channels", () => {
    const doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const content = doc.channel("content");
    const comments = doc.channel("comments");
    expect(content).not.toBe(comments);
    expect(content.name).toBe("content");
    expect(comments.name).toBe("comments");
  });

  it("identity is accessible", () => {
    const identity = fakeIdentity();
    const doc = createDocument({
      identity,
      capability: fakeCapability(),
    });

    expect(doc.identity).toBe(identity);
  });

  it("capability is accessible", () => {
    const capability = fakeCapability();
    const doc = createDocument({
      identity: fakeIdentity(),
      capability,
    });

    expect(doc.capability).toBe(capability);
  });

  it("destroy cascades to all channels", () => {
    const doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    const content = doc.channel("content");
    const comments = doc.channel("comments");

    const feed1 = content.activate(editCountView);
    const feed2 = comments.activate(editCountView);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    feed1.subscribe(cb1);
    feed2.subscribe(cb2);

    doc.destroy();

    content.appendEdit(fakeEdit(1));
    comments.appendEdit(fakeEdit(2));

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
