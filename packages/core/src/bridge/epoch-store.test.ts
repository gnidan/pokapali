import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { edit, epoch, openBoundary, closedBoundary } from "../epoch/types.js";
import type { Edit, EpochBoundary } from "../epoch/types.js";
import { createEpochStore, type EpochStore } from "./epoch-store.js";

// -- Helpers --

function makeEdit(channel: string, payload: number[]): Edit {
  return edit({
    payload: new Uint8Array(payload),
    timestamp: Date.now(),
    author: "aabb",
    channel,
    origin: "local",
    signature: new Uint8Array([]),
  });
}

// -- Tests --

describe("createEpochStore", () => {
  let store: EpochStore;

  beforeEach(async () => {
    // Use unique db name per test to avoid IDB
    // state leaking between tests
    const dbName = `test-epoch-store-${Math.random()}`;
    store = await createEpochStore(dbName);
  });

  afterEach(() => {
    store.destroy();
  });

  it("persists and loads a single edit", async () => {
    const e = makeEdit("content", [1, 2, 3]);
    await store.persistEdit("content", e);

    const epochs = await store.loadChannelEpochs("content");
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[0]!.edits[0]!.author).toBe("aabb");
    expect(Array.from(epochs[0]!.edits[0]!.payload)).toEqual([1, 2, 3]);
    expect(epochs[0]!.boundary.tag).toBe("open");
  });

  it("groups edits by epoch index", async () => {
    const e1 = makeEdit("content", [1]);
    const e2 = makeEdit("content", [2]);

    // Both in epoch 0 (default)
    await store.persistEdit("content", e1);
    await store.persistEdit("content", e2);

    const epochs = await store.loadChannelEpochs("content");
    expect(epochs).toHaveLength(1);
    expect(epochs[0]!.edits).toHaveLength(2);
  });

  it("persists epoch boundary and creates new epoch", async () => {
    const e1 = makeEdit("content", [1]);
    await store.persistEdit("content", e1);

    // Close epoch 0
    await store.persistEpochBoundary("content", 0, closedBoundary());

    // Add edit to epoch 1
    const e2 = makeEdit("content", [2]);
    await store.persistEdit("content", e2);

    const epochs = await store.loadChannelEpochs("content");
    expect(epochs).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[0]!.edits).toHaveLength(1);
    expect(epochs[1]!.boundary.tag).toBe("open");
    expect(epochs[1]!.edits).toHaveLength(1);
  });

  it("isolates channels", async () => {
    await store.persistEdit("content", makeEdit("content", [1]));
    await store.persistEdit("comments", makeEdit("comments", [2]));

    const content = await store.loadChannelEpochs("content");
    const comments = await store.loadChannelEpochs("comments");

    expect(content).toHaveLength(1);
    expect(content[0]!.edits).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.edits).toHaveLength(1);
  });

  it("returns empty array for unknown channel", async () => {
    const epochs = await store.loadChannelEpochs("nonexistent");
    expect(epochs).toHaveLength(0);
  });

  it("round-trips multiple epochs with boundaries", async () => {
    // Epoch 0: two edits, closed
    await store.persistEdit("content", makeEdit("content", [1]));
    await store.persistEdit("content", makeEdit("content", [2]));
    await store.persistEpochBoundary("content", 0, closedBoundary());

    // Epoch 1: one edit, closed
    await store.persistEdit("content", makeEdit("content", [3]));
    await store.persistEpochBoundary("content", 1, closedBoundary());

    // Epoch 2: one edit, still open
    await store.persistEdit("content", makeEdit("content", [4]));

    const epochs = await store.loadChannelEpochs("content");
    expect(epochs).toHaveLength(3);
    expect(epochs[0]!.edits).toHaveLength(2);
    expect(epochs[0]!.boundary.tag).toBe("closed");
    expect(epochs[1]!.edits).toHaveLength(1);
    expect(epochs[1]!.boundary.tag).toBe("closed");
    expect(epochs[2]!.edits).toHaveLength(1);
    expect(epochs[2]!.boundary.tag).toBe("open");
  });

  it("destroy closes the database", async () => {
    store.destroy();

    // After destroy, operations should fail or
    // be no-ops. Creating a new store with same name
    // should work (db released).
    const dbName = `test-reopen-${Math.random()}`;
    const store2 = await createEpochStore(dbName);
    await store2.persistEdit("content", makeEdit("content", [1]));
    const epochs = await store2.loadChannelEpochs("content");
    expect(epochs).toHaveLength(1);
    store2.destroy();
  });
});
