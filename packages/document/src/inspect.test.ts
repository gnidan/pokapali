/**
 * inspect.test.ts — tests for inspect with optional
 * { upTo } prefix evaluation.
 *
 * Uses a simple counting Measured (sum of edit counts
 * per epoch) to verify tree fold behavior without
 * needing a real codec.
 */
import { describe, it, expect } from "vitest";
import type { Measured } from "@pokapali/finger-tree";
import { inspect } from "./inspect.js";
import { Document } from "./document/document.js";
import { View } from "./view.js";
import { Epoch, Boundary, Edit } from "./history/index.js";
import { generateIdentityKeypair } from "@pokapali/crypto";
import type { Capability } from "./capability/capability.js";

// --- Helpers ---

/**
 * Counting monoid: sum of edit counts per epoch.
 * Simple, no codec needed.
 */
const countMeasured: Measured<number, Epoch> = {
  monoid: {
    empty: 0,
    append: (a, b) => a + b,
  },
  measure: (ep) => ep.edits.length,
};

function countView(channel: string): View<number> {
  return View.singleChannel({
    name: "edit-count",
    description: "Count of edits",
    channel,
    measured: countMeasured,
  });
}

function makeEdit(n: number, channel: string): Edit {
  return Edit.create({
    payload: new Uint8Array([n]),
    timestamp: n * 1000,
    author: "alice",
    channel,
    origin: "local",
    signature: new Uint8Array(),
  });
}

const fakeCap: Capability = {
  channels: new Set(["content", "comments"]),
  canPushSnapshots: false,
  isAdmin: false,
};

async function makeDocument(channelName: string, epochs: Epoch[]) {
  const identity = await generateIdentityKeypair();
  const doc = Document.create({
    identity,
    capability: fakeCap,
  });

  const ch = doc.channel(channelName);

  for (let i = 0; i < epochs.length; i++) {
    const ep = epochs[i]!;
    for (const edit of ep.edits) {
      ch.appendEdit(edit);
    }
    if (ep.boundary.tag !== "open") {
      ch.closeEpoch();
    }
  }

  return doc;
}

// --- Tests ---

describe("inspect", () => {
  it("returns monoid empty for empty channel", async () => {
    const doc = await makeDocument("content", []);
    const v = countView("content");
    const result = inspect(v, doc);
    expect(result).toBe(0);
  });

  it("folds all epochs", async () => {
    const doc = await makeDocument("content", [
      Epoch.create(
        [makeEdit(1, "content"), makeEdit(2, "content")],
        Boundary.closed(),
      ),
      Epoch.create([makeEdit(3, "content")], Boundary.open()),
    ]);
    const v = countView("content");
    const result = inspect(v, doc);
    expect(result).toBe(3);
  });
});

describe("inspect with { upTo }", () => {
  it("returns monoid empty for upTo 0", async () => {
    const doc = await makeDocument("content", [
      Epoch.create([makeEdit(1, "content")], Boundary.closed()),
      Epoch.create([makeEdit(2, "content")], Boundary.open()),
    ]);
    const v = countView("content");
    const result = inspect(v, doc, { upTo: 0 });
    expect(result).toBe(0);
  });

  it("evaluates prefix up to epoch count", async () => {
    const doc = await makeDocument("content", [
      Epoch.create(
        [makeEdit(1, "content"), makeEdit(2, "content")],
        Boundary.closed(),
      ),
      Epoch.create([makeEdit(3, "content")], Boundary.closed()),
      Epoch.create([makeEdit(4, "content")], Boundary.open()),
    ]);
    const v = countView("content");

    // First epoch only (2 edits)
    expect(inspect(v, doc, { upTo: 1 })).toBe(2);
    // First two epochs (2 + 1 = 3)
    expect(inspect(v, doc, { upTo: 2 })).toBe(3);
  });

  it("evaluates full tree when upTo >= tree size", async () => {
    const doc = await makeDocument("content", [
      Epoch.create([makeEdit(1, "content")], Boundary.closed()),
      Epoch.create([makeEdit(2, "content")], Boundary.open()),
    ]);
    const v = countView("content");
    const full = inspect(v, doc);
    const atLarge = inspect(v, doc, { upTo: 100 });
    expect(atLarge).toBe(full);
  });

  it("works with multi-channel views", async () => {
    const identity = await generateIdentityKeypair();
    const doc = Document.create({
      identity,
      capability: fakeCap,
    });

    const content = doc.channel("content");
    content.appendEdit(makeEdit(1, "content"));
    content.appendEdit(makeEdit(2, "content"));
    content.closeEpoch();
    content.appendEdit(makeEdit(3, "content"));

    const comments = doc.channel("comments");
    comments.appendEdit(makeEdit(10, "comments"));
    comments.closeEpoch();
    comments.appendEdit(makeEdit(11, "comments"));

    const v = View.create({
      name: "total-edits",
      description: "Sum edit counts across channels",
      channels: {
        content: countMeasured,
        comments: countMeasured,
      },
      combine: (results) =>
        (results.content as number) + (results.comments as number),
    });

    // At epoch 1: content has 2, comments has 1
    const at1 = inspect(v, doc, { upTo: 1 });
    expect(at1).toBe(3);
  });
});
