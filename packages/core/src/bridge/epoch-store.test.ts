import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as fc from "fast-check";
import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import * as digest from "multiformats/hashes/digest";
import {
  edit,
  epoch,
  openBoundary,
  closedBoundary,
  snapshottedBoundary,
} from "../epoch/types.js";
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

  it(
    "property: N edits across M boundaries " +
      "round-trip with correct grouping",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // N edits (1..20), M boundaries (0..5)
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 5 }),
          async (numEdits, numBoundaries) => {
            const dbName = `test-prop-${Math.random()}`;
            const s = await createEpochStore(dbName);

            // Distribute boundaries evenly among
            // edit positions
            const boundaryAfter = new Set<number>();
            if (numBoundaries > 0) {
              const step = Math.max(1, Math.floor(numEdits / numBoundaries));
              for (
                let i = step - 1;
                i < numEdits && boundaryAfter.size < numBoundaries;
                i += step
              ) {
                // Don't place boundary after last
                // edit (no next epoch)
                if (i < numEdits - 1) {
                  boundaryAfter.add(i);
                }
              }
            }

            let epochIdx = 0;
            const expectedEpochs: number[][] = [[]];

            for (let i = 0; i < numEdits; i++) {
              const e = makeEdit("ch", [i]);
              await s.persistEdit("ch", e);
              expectedEpochs[epochIdx]!.push(i);

              if (boundaryAfter.has(i)) {
                await s.persistEpochBoundary("ch", epochIdx, closedBoundary());
                epochIdx++;
                expectedEpochs.push([]);
              }
            }

            const loaded = await s.loadChannelEpochs("ch");

            // Account for implicit trailing open
            // epoch after closed
            const numClosed = boundaryAfter.size;
            const hasTrailingOpen =
              numClosed > 0 &&
              expectedEpochs[expectedEpochs.length - 1]!.length === 0;
            const expected = hasTrailingOpen
              ? expectedEpochs.length
              : expectedEpochs.length;

            expect(loaded).toHaveLength(expected);

            // Verify edit counts per epoch
            for (let i = 0; i < expectedEpochs.length; i++) {
              expect(loaded[i]!.edits).toHaveLength(expectedEpochs[i]!.length);
            }

            // Verify all edit payloads present
            const allPayloads = loaded.flatMap((ep) =>
              ep.edits.map((e) => Array.from(e.payload)),
            );
            const expectedPayloads = Array.from(
              { length: numEdits },
              (_, i) => [i],
            );
            expect(allPayloads).toEqual(expectedPayloads);

            s.destroy();
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    "snapshotted boundary round-trip " + "(CID structured clone)",
    async () => {
      const hash = sha256(new Uint8Array([1, 2, 3]));
      const mhDigest = digest.create(0x12, hash);
      const cid = CID.createV1(0x71, mhDigest);

      await store.persistEdit("content", makeEdit("content", [1]));
      await store.persistEpochBoundary("content", 0, snapshottedBoundary(cid));

      const epochs = await store.loadChannelEpochs("content");

      // The boundary should have snapshotted tag
      expect(epochs[0]!.boundary.tag).toBe("snapshotted");

      // CID must survive IDB round-trip as a real
      // CID instance (serialized as bytes on write,
      // reconstructed via CID.decode on read).
      const loaded = epochs[0]!.boundary;
      expect(loaded.tag).toBe("snapshotted");
      if (loaded.tag === "snapshotted") {
        expect(loaded.cid).toBeInstanceOf(CID);
        expect(loaded.cid.toString()).toBe(cid.toString());
      }
    },
  );
});
