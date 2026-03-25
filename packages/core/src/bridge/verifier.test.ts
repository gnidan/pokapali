import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import * as Y from "yjs";
import { toArray } from "@pokapali/finger-tree";
import type { SubdocManager } from "@pokapali/subdocs";
import type { CrdtCodec } from "../codec/codec.js";
import { createDocument } from "../document/document.js";
import type { Document } from "../document/document.js";
import { createEditBridge } from "./edit-bridge.js";
import { createParallelVerifier, type VerifyResult } from "./verifier.js";

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

function mockSubdocManager(channelNames: string[]): {
  manager: SubdocManager;
  docs: Map<string, Y.Doc>;
} {
  const docs = new Map<string, Y.Doc>();
  for (const name of channelNames) {
    docs.set(name, new Y.Doc());
  }

  const manager: SubdocManager = {
    subdoc(ns: string): Y.Doc {
      let doc = docs.get(ns);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(ns, doc);
      }
      return doc;
    },
    get metaDoc(): Y.Doc {
      return new Y.Doc();
    },
    encodeAll() {
      return {};
    },
    applySnapshot() {},
    get isDirty() {
      return false;
    },
    on() {},
    off() {},
    whenLoaded: Promise.resolve(),
    destroy() {},
  };

  return { manager, docs };
}

/**
 * Y.Doc-based codec — uses real Yjs merge/diff
 * for faithful verification testing.
 */
function yjsCodec(): CrdtCodec {
  return {
    merge(a: Uint8Array, b: Uint8Array): Uint8Array {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, a);
      Y.applyUpdate(doc, b);
      return Y.encodeStateAsUpdate(doc);
    },
    diff(state: Uint8Array, base: Uint8Array): Uint8Array {
      const baseDoc = new Y.Doc();
      Y.applyUpdate(baseDoc, base);
      const sv = Y.encodeStateVector(baseDoc);
      const stateDoc = new Y.Doc();
      Y.applyUpdate(stateDoc, state);
      return Y.encodeStateAsUpdate(stateDoc, sv);
    },
    apply(base: Uint8Array, update: Uint8Array): Uint8Array {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, base);
      Y.applyUpdate(doc, update);
      return Y.encodeStateAsUpdate(doc);
    },
    empty(): Uint8Array {
      return Y.encodeStateAsUpdate(new Y.Doc());
    },
    contains(snapshot: Uint8Array, edit: Uint8Array): boolean {
      const base = new Y.Doc();
      Y.applyUpdate(base, snapshot);
      const sv = Y.encodeStateVector(base);
      const editDoc = new Y.Doc();
      Y.applyUpdate(editDoc, edit);
      const diff = Y.encodeStateAsUpdate(editDoc, sv);
      // Empty diff = [0, 0] in Yjs
      return diff.length <= 2;
    },
  };
}

// -- Tests --

describe("createParallelVerifier", () => {
  let doc: Document;

  beforeEach(() => {
    doc = createDocument({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
  });

  it("matching — local edits only", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Local edit
    docs.get("content")!.getArray("data").push(["hello"]);

    const verifier = createParallelVerifier({
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
    });

    const result = verifier.verify("content");
    expect(result.match).toBe(true);
    expect(result.channel).toBe("content");
    expect(result.epochCount).toBeGreaterThan(0);

    // contentHash should be present for diagnostics
    expect(result.contentHash).toBeInstanceOf(Uint8Array);
    expect(result.contentHash!.length).toBeGreaterThan(0);

    bridge.destroy();
  });

  it("matching — local + remote edits", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Local edit
    const yDoc = docs.get("content")!;
    yDoc.getArray("data").push(["local"]);

    // Remote edit
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray("data").push(["remote"]);
    const update = Y.encodeStateAsUpdate(remoteDoc);
    Y.applyUpdate(yDoc, update, "provider");

    const verifier = createParallelVerifier({
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
    });

    const result = verifier.verify("content");
    expect(result.match).toBe(true);
    expect(result.channel).toBe("content");

    bridge.destroy();
  });

  it("divergence detection — extra edit in tree", async () => {
    const { manager, docs } = mockSubdocManager(["content"]);
    const codec = yjsCodec();

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Normal edit through bridge
    docs.get("content")!.getArray("data").push(["real"]);

    bridge.destroy();

    // Inject a phantom edit directly into the
    // channel tree (Y.Doc doesn't have it)
    const phantomDoc = new Y.Doc();
    phantomDoc.getArray("other").push(["phantom"]);
    const phantomUpdate = Y.encodeStateAsUpdate(phantomDoc);

    const { edit } = await import("../epoch/types.js");
    doc.channel("content").appendEdit(
      edit({
        payload: phantomUpdate,
        timestamp: Date.now(),
        author: "phantom",
        channel: "content",
        origin: "local",
        signature: new Uint8Array([]),
      }),
    );

    const verifier = createParallelVerifier({
      document: doc,
      subdocManager: manager,
      channelNames: ["content"],
      codec,
    });

    const result = verifier.verify("content");
    expect(result.match).toBe(false);
    expect(result.details).toBeDefined();
  });

  it("multiple channels independent", async () => {
    const { manager, docs } = mockSubdocManager(["content", "comments"]);
    const codec = yjsCodec();

    const bridge = createEditBridge({
      subdocManager: manager,
      document: doc,
      channelNames: ["content", "comments"],
      localAuthor: "aabb",
    });
    await bridge.start();

    // Edit both channels
    docs.get("content")!.getArray("data").push(["c1"]);
    docs.get("comments")!.getArray("data").push(["m1"]);

    const verifier = createParallelVerifier({
      document: doc,
      subdocManager: manager,
      channelNames: ["content", "comments"],
      codec,
    });

    const results = verifier.verifyAll();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.match)).toBe(true);
    expect(results[0]!.channel).toBe("content");
    expect(results[1]!.channel).toBe("comments");

    bridge.destroy();
  });

  it(
    "property: N random edits → bridge → " + "closeEpoch → verify matches",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (numEdits) => {
          const d = createDocument({
            identity: fakeIdentity(),
            capability: fakeCapability(),
          });
          const { manager, docs } = mockSubdocManager(["content"]);
          const codec = yjsCodec();

          const bridge = createEditBridge({
            subdocManager: manager,
            document: d,
            channelNames: ["content"],
            localAuthor: "aabb",
          });
          await bridge.start();

          const yDoc = docs.get("content")!;
          for (let i = 0; i < numEdits; i++) {
            yDoc.getArray("data").push([`edit-${i}`]);
          }

          // Close epoch
          d.channel("content").closeEpoch();

          const verifier = createParallelVerifier({
            document: d,
            subdocManager: manager,
            channelNames: ["content"],
            codec,
          });

          const result = verifier.verify("content");
          expect(result.match).toBe(true);
          expect(result.epochCount).toBeGreaterThanOrEqual(2);

          bridge.destroy();
          d.destroy();
        }),
        { numRuns: 50 },
      );
    },
  );

  it(
    "property: divergence detected when " + "phantom edit injected",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (numEdits) => {
          const d = createDocument({
            identity: fakeIdentity(),
            capability: fakeCapability(),
          });
          const { manager, docs } = mockSubdocManager(["content"]);
          const codec = yjsCodec();

          const bridge = createEditBridge({
            subdocManager: manager,
            document: d,
            channelNames: ["content"],
            localAuthor: "aabb",
          });
          await bridge.start();

          const yDoc = docs.get("content")!;
          for (let i = 0; i < numEdits; i++) {
            yDoc.getArray("data").push([`e-${i}`]);
          }

          bridge.destroy();

          // Inject phantom edit into tree only
          const phantomDoc = new Y.Doc();
          phantomDoc.getArray("phantom").push(["diverge"]);
          const phantomUpdate = Y.encodeStateAsUpdate(phantomDoc);

          const { edit } = await import("../epoch/types.js");
          d.channel("content").appendEdit(
            edit({
              payload: phantomUpdate,
              timestamp: Date.now(),
              author: "phantom",
              channel: "content",
              origin: "local",
              signature: new Uint8Array([]),
            }),
          );

          const verifier = createParallelVerifier({
            document: d,
            subdocManager: manager,
            channelNames: ["content"],
            codec,
          });

          const result = verifier.verify("content");
          expect(result.match).toBe(false);
          expect(result.details).toBeDefined();
          expect(result.details!.length).toBeGreaterThan(0);

          d.destroy();
        }),
        { numRuns: 30 },
      );
    },
  );
});
