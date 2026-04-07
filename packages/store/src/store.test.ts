import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import * as fc from "fast-check";
import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import * as digest from "multiformats/hashes/digest";
import { Edit, Boundary, type Edit as EditType } from "@pokapali/document";
import { Store } from "./store.js";

// -- Helpers --

function makeEdit(channel: string, payload: number[]): EditType {
  return Edit.create({
    payload: new Uint8Array(payload),
    timestamp: Date.now(),
    author: "aabb",
    channel,
    origin: "local",
    signature: new Uint8Array([]),
  });
}

let nextId = 0;
function freshId(): string {
  return `test-${++nextId}-${Math.random()}`;
}

// -- Tests --

describe("Store", () => {
  let store: Store;

  beforeEach(async () => {
    store = await Store.create(freshId());
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------
  // Identity
  // -------------------------------------------------

  describe("identity", () => {
    it("returns null for unknown id", async () => {
      const result = await store.identity.load("device");
      expect(result).toBeNull();
    });

    it("saves and loads a seed", async () => {
      const seed = new Uint8Array([1, 2, 3, 4]);
      await store.identity.save("device", seed);
      const loaded = await store.identity.load("device");
      expect(loaded).toEqual(seed);
    });

    it("overwrites existing seed", async () => {
      const s1 = new Uint8Array([1, 2, 3]);
      const s2 = new Uint8Array([4, 5, 6]);
      await store.identity.save("device", s1);
      await store.identity.save("device", s2);
      const loaded = await store.identity.load("device");
      expect(loaded).toEqual(s2);
    });

    it("isolates by id", async () => {
      const s1 = new Uint8Array([1]);
      const s2 = new Uint8Array([2]);
      await store.identity.save("device", s1);
      await store.identity.save("backup", s2);
      expect(await store.identity.load("device")).toEqual(s1);
      expect(await store.identity.load("backup")).toEqual(s2);
    });
  });

  // -------------------------------------------------
  // History
  // -------------------------------------------------

  describe("history", () => {
    const DOC = "k51test-doc-1";

    it("persists and loads a single edit", async () => {
      const doc = store.documents.get(DOC);
      const hist = doc.history("content");
      const e = makeEdit("content", [1, 2, 3]);
      await hist.append(0, e);

      const epochs = await hist.load();
      expect(epochs).toHaveLength(1);
      expect(epochs[0]!.edits).toHaveLength(1);
      expect(epochs[0]!.edits[0]!.author).toBe("aabb");
      expect(Array.from(epochs[0]!.edits[0]!.payload)).toEqual([1, 2, 3]);
      expect(epochs[0]!.boundary.tag).toBe("open");
    });

    it("groups edits by epoch index", async () => {
      const hist = store.documents.get(DOC).history("content");
      await hist.append(0, makeEdit("content", [1]));
      await hist.append(0, makeEdit("content", [2]));

      const epochs = await hist.load();
      expect(epochs).toHaveLength(1);
      expect(epochs[0]!.edits).toHaveLength(2);
    });

    it("closes epoch and creates new one", async () => {
      const hist = store.documents.get(DOC).history("content");
      await hist.append(0, makeEdit("content", [1]));
      await hist.close(0, Boundary.closed());
      await hist.append(1, makeEdit("content", [2]));

      const epochs = await hist.load();
      expect(epochs).toHaveLength(2);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      expect(epochs[0]!.edits).toHaveLength(1);
      expect(epochs[1]!.boundary.tag).toBe("open");
      expect(epochs[1]!.edits).toHaveLength(1);
    });

    it("isolates channels", async () => {
      const doc = store.documents.get(DOC);
      await doc.history("content").append(0, makeEdit("content", [1]));
      await doc.history("comments").append(0, makeEdit("comments", [2]));

      const content = await doc.history("content").load();
      const comments = await doc.history("comments").load();

      expect(content).toHaveLength(1);
      expect(content[0]!.edits).toHaveLength(1);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.edits).toHaveLength(1);
    });

    it("isolates documents", async () => {
      const docA = store.documents.get("doc-a");
      const docB = store.documents.get("doc-b");
      await docA.history("content").append(0, makeEdit("content", [1]));
      await docB.history("content").append(0, makeEdit("content", [2]));

      const epochsA = await docA.history("content").load();
      const epochsB = await docB.history("content").load();

      expect(epochsA).toHaveLength(1);
      expect(Array.from(epochsA[0]!.edits[0]!.payload)).toEqual([1]);
      expect(epochsB).toHaveLength(1);
      expect(Array.from(epochsB[0]!.edits[0]!.payload)).toEqual([2]);
    });

    it("returns empty for unknown channel", async () => {
      const epochs = await store.documents
        .get(DOC)
        .history("nonexistent")
        .load();
      expect(epochs).toHaveLength(0);
    });

    it("round-trips multiple epochs with boundaries", async () => {
      const hist = store.documents.get(DOC).history("content");
      await hist.append(0, makeEdit("content", [1]));
      await hist.append(0, makeEdit("content", [2]));
      await hist.close(0, Boundary.closed());
      await hist.append(1, makeEdit("content", [3]));
      await hist.close(1, Boundary.closed());
      await hist.append(2, makeEdit("content", [4]));

      const epochs = await hist.load();
      expect(epochs).toHaveLength(3);
      expect(epochs[0]!.edits).toHaveLength(2);
      expect(epochs[0]!.boundary.tag).toBe("closed");
      expect(epochs[1]!.edits).toHaveLength(1);
      expect(epochs[1]!.boundary.tag).toBe("closed");
      expect(epochs[2]!.edits).toHaveLength(1);
      expect(epochs[2]!.boundary.tag).toBe("open");
    });

    it("snapshotted boundary round-trips CID", async () => {
      const hash = sha256(new Uint8Array([1, 2, 3]));
      const mhDigest = digest.create(0x12, hash);
      const cid = CID.createV1(0x71, mhDigest);

      const hist = store.documents.get(DOC).history("content");
      await hist.append(0, makeEdit("content", [1]));
      await hist.close(0, Boundary.snapshotted(cid));

      const epochs = await hist.load();
      expect(epochs[0]!.boundary.tag).toBe("snapshotted");
      const loaded = epochs[0]!.boundary;
      if (loaded.tag === "snapshotted") {
        expect(loaded.cid).toBeInstanceOf(CID);
        expect(loaded.cid.toString()).toBe(cid.toString());
      }
    });

    it(
      "property: N edits across M boundaries " +
        "round-trip with correct grouping",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 20 }),
            fc.integer({ min: 0, max: 5 }),
            async (numEdits, numBoundaries) => {
              const s = await Store.create(freshId());
              const hist = s.documents.get("prop-doc").history("ch");

              const boundaryAfter = new Set<number>();
              if (numBoundaries > 0) {
                const step = Math.max(1, Math.floor(numEdits / numBoundaries));
                for (
                  let i = step - 1;
                  i < numEdits && boundaryAfter.size < numBoundaries;
                  i += step
                ) {
                  if (i < numEdits - 1) {
                    boundaryAfter.add(i);
                  }
                }
              }

              let epochIdx = 0;
              const expectedEpochs: number[][] = [[]];

              for (let i = 0; i < numEdits; i++) {
                await hist.append(epochIdx, makeEdit("ch", [i]));
                expectedEpochs[epochIdx]!.push(i);

                if (boundaryAfter.has(i)) {
                  await hist.close(epochIdx, Boundary.closed());
                  epochIdx++;
                  expectedEpochs.push([]);
                }
              }

              const loaded = await hist.load();
              expect(loaded).toHaveLength(expectedEpochs.length);

              for (let i = 0; i < expectedEpochs.length; i++) {
                expect(loaded[i]!.edits).toHaveLength(
                  expectedEpochs[i]!.length,
                );
              }

              const allPayloads = loaded.flatMap((ep) =>
                ep.edits.map((e) => Array.from(e.payload)),
              );
              const expectedPayloads = Array.from(
                { length: numEdits },
                (_, i) => [i],
              );
              expect(allPayloads).toEqual(expectedPayloads);

              s.close();
            },
          ),
          { numRuns: 50 },
        );
      },
    );
  });

  // -------------------------------------------------
  // Snapshots
  // -------------------------------------------------

  describe("snapshots", () => {
    const DOC = "k51test-doc-1";

    it("returns empty for new document", async () => {
      const all = await store.documents.get(DOC).snapshots.loadAll();
      expect(all).toHaveLength(0);
    });

    it("appends and loads snapshots", async () => {
      const snaps = store.documents.get(DOC).snapshots;
      await snaps.append({
        cid: new Uint8Array([1, 2, 3]),
        seq: 0,
        ts: 1000,
        channel: "content",
        epochIndex: 0,
      });
      await snaps.append({
        cid: new Uint8Array([4, 5, 6]),
        seq: 1,
        ts: 2000,
        channel: "content",
        epochIndex: 1,
      });

      const all = await snaps.loadAll();
      expect(all).toHaveLength(2);
      expect(all[0]!.seq).toBe(0);
      expect(all[0]!.cid).toEqual(new Uint8Array([1, 2, 3]));
      expect(all[1]!.seq).toBe(1);
    });

    it("isolates documents", async () => {
      const snapsA = store.documents.get("doc-a").snapshots;
      const snapsB = store.documents.get("doc-b").snapshots;

      await snapsA.append({
        cid: new Uint8Array([1]),
        seq: 0,
        ts: 1000,
        channel: "content",
        epochIndex: 0,
      });
      await snapsB.append({
        cid: new Uint8Array([2]),
        seq: 0,
        ts: 2000,
        channel: "content",
        epochIndex: 0,
      });

      const allA = await snapsA.loadAll();
      const allB = await snapsB.loadAll();
      expect(allA).toHaveLength(1);
      expect(allB).toHaveLength(1);
      expect(allA[0]!.cid).toEqual(new Uint8Array([1]));
      expect(allB[0]!.cid).toEqual(new Uint8Array([2]));
    });
  });

  // -------------------------------------------------
  // View cache
  // -------------------------------------------------

  describe("viewCache", () => {
    const DOC = "k51test-doc-1";

    it("returns null for missing entry", async () => {
      const result = await store.documents
        .get(DOC)
        .viewCache.load("state", "content", 0);
      expect(result).toBeNull();
    });

    it("saves and loads a cache entry", async () => {
      const vc = store.documents.get(DOC).viewCache;
      const data = new Uint8Array([1, 2, 3]);
      await vc.save("state", "content", 0, data);
      const result = await vc.load("state", "content", 0);
      expect(result).toEqual(data);
    });

    it("overwrites existing entry", async () => {
      const vc = store.documents.get(DOC).viewCache;
      await vc.save("state", "content", 0, new Uint8Array([1]));
      await vc.save("state", "content", 0, new Uint8Array([2]));
      const result = await vc.load("state", "content", 0);
      expect(result).toEqual(new Uint8Array([2]));
    });

    it("isolates by viewName", async () => {
      const vc = store.documents.get(DOC).viewCache;
      await vc.save("state", "content", 0, new Uint8Array([1]));
      await vc.save("fingerprint", "content", 0, new Uint8Array([2]));
      expect(await vc.load("state", "content", 0)).toEqual(new Uint8Array([1]));
      expect(await vc.load("fingerprint", "content", 0)).toEqual(
        new Uint8Array([2]),
      );
    });

    it("isolates documents", async () => {
      const vcA = store.documents.get("doc-a").viewCache;
      const vcB = store.documents.get("doc-b").viewCache;
      await vcA.save("state", "content", 0, new Uint8Array([1]));
      await vcB.save("state", "content", 0, new Uint8Array([2]));
      expect(await vcA.load("state", "content", 0)).toEqual(
        new Uint8Array([1]),
      );
      expect(await vcB.load("state", "content", 0)).toEqual(
        new Uint8Array([2]),
      );
    });
  });

  // -------------------------------------------------
  // Document.destroy
  // -------------------------------------------------

  describe("document.destroy", () => {
    it("removes all data for the document", async () => {
      const doc = store.documents.get("doc-x");
      const hist = doc.history("content");
      await hist.append(0, makeEdit("content", [1]));
      await hist.close(0, Boundary.closed());
      await doc.snapshots.append({
        cid: new Uint8Array([1]),
        seq: 0,
        ts: 1000,
        channel: "content",
        epochIndex: 0,
      });
      await doc.viewCache.save("state", "content", 0, new Uint8Array([1]));

      await doc.destroy();

      const epochs = await hist.load();
      expect(epochs).toHaveLength(0);
      const snaps = await doc.snapshots.loadAll();
      expect(snaps).toHaveLength(0);
      const cached = await doc.viewCache.load("state", "content", 0);
      expect(cached).toBeNull();
    });

    it("does not affect other documents", async () => {
      const docA = store.documents.get("doc-a");
      const docB = store.documents.get("doc-b");
      await docA.history("content").append(0, makeEdit("content", [1]));
      await docB.history("content").append(0, makeEdit("content", [2]));

      await docA.destroy();

      const epochsA = await docA.history("content").load();
      const epochsB = await docB.history("content").load();
      expect(epochsA).toHaveLength(0);
      expect(epochsB).toHaveLength(1);
    });
  });

  // -------------------------------------------------
  // close
  // -------------------------------------------------

  describe("close + reopen", () => {
    it("closes the database", async () => {
      store.close();
      // Can open a new store without error
      const s2 = await Store.create(freshId());
      await s2.identity.save("device", new Uint8Array([1]));
      expect(await s2.identity.load("device")).toEqual(new Uint8Array([1]));
      s2.close();
    });

    it("edits survive close + reopen", async () => {
      const appId = freshId();
      const s1 = await Store.create(appId);
      const doc1 = s1.documents.get("test-doc");
      await doc1.history("content").append(0, makeEdit("content", [1, 2]));
      await doc1.history("content").append(0, makeEdit("content", [3, 4]));
      s1.close();

      const s2 = await Store.create(appId);
      const doc2 = s2.documents.get("test-doc");
      const epochs = await doc2.history("content").load();
      expect(epochs).toHaveLength(1);
      expect(epochs[0]!.edits).toHaveLength(2);
      expect(Array.from(epochs[0]!.edits[0]!.payload)).toEqual([1, 2]);
      expect(Array.from(epochs[0]!.edits[1]!.payload)).toEqual([3, 4]);
      s2.close();
    });
  });
});
