/**
 * Property test: State view fold ≡ Y.Doc state
 * for arbitrary edit sequences.
 *
 * Verifies that folding the epoch tree with
 * State.channelMeasured(codec) produces the same
 * CRDT state as applying the same edits to a
 * standalone Y.Doc directly.
 *
 * This is the safety net for snapshot
 * materialization cutover: both paths must
 * converge to identical state.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { yjsCodec } from "@pokapali/codec";
import { Document, Edit, Cache, foldTree, State } from "@pokapali/document";
import { generateIdentityKeypair } from "@pokapali/crypto";
import { Capability } from "@pokapali/document";

// --- Helpers ---

const codec = yjsCodec;

const fakeCap: Capability = {
  channels: new Set(["content", "comments"]),
  canPushSnapshots: false,
  isAdmin: false,
};

/**
 * Generate a Yjs update (edit payload) by writing
 * key-value entries to a fresh Y.Doc map.
 */
function arbEditPayload(): fc.Arbitrary<Uint8Array> {
  return fc
    .array(
      fc.tuple(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.oneof(fc.integer(), fc.string({ maxLength: 20 })),
      ),
      { minLength: 1, maxLength: 5 },
    )
    .map((entries) => {
      const doc = new Y.Doc();
      const map = doc.getMap("data");
      for (const [k, v] of entries) {
        map.set(k, v);
      }
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    });
}

/**
 * Generate a sequence of edit payloads with epoch
 * boundaries. Each element is either an edit payload
 * or a "close" marker.
 */
type EditOrClose = { tag: "edit"; payload: Uint8Array } | { tag: "close" };

function arbEditSequence(): fc.Arbitrary<EditOrClose[]> {
  return fc.array(
    fc.oneof(
      {
        weight: 4,
        arbitrary: arbEditPayload().map(
          (p): EditOrClose => ({
            tag: "edit",
            payload: p,
          }),
        ),
      },
      {
        weight: 1,
        arbitrary: fc.constant({
          tag: "close",
        } as EditOrClose),
      },
    ),
    { minLength: 1, maxLength: 10 },
  );
}

function makeEdit(
  payload: Uint8Array,
  channel: string,
  timestamp: number,
): Edit {
  return Edit.create({
    payload,
    timestamp,
    author: "test-author",
    channel,
    origin: "local",
    signature: new Uint8Array(),
  });
}

/**
 * Compare two Yjs states for semantic equality
 * by checking that neither contains operations
 * the other lacks.
 */
function statesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return codec.contains(b, a) && codec.contains(a, b);
}

// --- Property tests ---

describe("snapshot materialization equivalence", () => {
  it("State fold ≡ Y.Doc encode " + "for single channel", async () => {
    const identity = await generateIdentityKeypair();

    await fc.assert(
      fc.asyncProperty(arbEditSequence(), async (ops) => {
        // Path 1: Document + epoch tree
        const doc = Document.create({
          identity,
          capability: fakeCap,
          codec,
        });
        const ch = doc.channel("content");

        // Path 2: standalone Y.Doc
        const ydoc = new Y.Doc();

        let ts = 0;
        for (const op of ops) {
          if (op.tag === "edit") {
            ch.appendEdit(makeEdit(op.payload, "content", ts++));
            Y.applyUpdate(ydoc, op.payload);
          } else {
            ch.closeEpoch();
          }
        }

        // Path 1: fold the tree
        const measured = State.channelMeasured(codec);
        const cache = Cache.create<Uint8Array>();
        const foldResult = foldTree<Uint8Array>(measured, ch.tree, cache);

        // Path 2: encode Y.Doc
        const encodeResult = Y.encodeStateAsUpdate(ydoc);

        expect(statesEqual(foldResult, encodeResult)).toBe(true);

        doc.destroy();
        ydoc.destroy();
      }),
      { numRuns: 50 },
    );
  });

  it("State fold ≡ Y.Doc encode " + "for multiple channels", async () => {
    const identity = await generateIdentityKeypair();
    const channels = ["content", "comments"];

    await fc.assert(
      fc.asyncProperty(
        arbEditSequence(),
        arbEditSequence(),
        async (contentOps, commentOps) => {
          const doc = Document.create({
            identity,
            capability: fakeCap,
            codec,
          });

          const ydocs = new Map<string, Y.Doc>();
          for (const ch of channels) {
            ydocs.set(ch, new Y.Doc());
          }

          // Apply content ops
          const contentCh = doc.channel("content");
          const contentYdoc = ydocs.get("content")!;
          let ts = 0;
          for (const op of contentOps) {
            if (op.tag === "edit") {
              contentCh.appendEdit(makeEdit(op.payload, "content", ts++));
              Y.applyUpdate(contentYdoc, op.payload);
            } else {
              contentCh.closeEpoch();
            }
          }

          // Apply comments ops
          const commentsCh = doc.channel("comments");
          const commentsYdoc = ydocs.get("comments")!;
          for (const op of commentOps) {
            if (op.tag === "edit") {
              commentsCh.appendEdit(makeEdit(op.payload, "comments", ts++));
              Y.applyUpdate(commentsYdoc, op.payload);
            } else {
              commentsCh.closeEpoch();
            }
          }

          const measured = State.channelMeasured(codec);

          for (const chName of channels) {
            const cache = Cache.create<Uint8Array>();
            const foldResult = foldTree<Uint8Array>(
              measured,
              doc.channel(chName).tree,
              cache,
            );
            const encodeResult = Y.encodeStateAsUpdate(ydocs.get(chName)!);

            expect(statesEqual(foldResult, encodeResult)).toBe(true);
          }

          doc.destroy();
          for (const d of ydocs.values()) {
            d.destroy();
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it(
    "equivalence holds after snapshot " + "apply + further edits",
    async () => {
      const identity = await generateIdentityKeypair();

      await fc.assert(
        fc.asyncProperty(
          arbEditSequence(),
          arbEditSequence(),
          async (phase1, phase2) => {
            // Phase 1: build initial state
            const doc = Document.create({
              identity,
              capability: fakeCap,
              codec,
            });
            const ch = doc.channel("content");

            const ydoc = new Y.Doc();

            let ts = 0;
            for (const op of phase1) {
              if (op.tag === "edit") {
                ch.appendEdit(makeEdit(op.payload, "content", ts++));
                Y.applyUpdate(ydoc, op.payload);
              } else {
                ch.closeEpoch();
              }
            }

            // Take a snapshot
            const snapshot = Y.encodeStateAsUpdate(ydoc);

            // Create a fresh Y.Doc and apply the
            // snapshot
            const ydoc2 = new Y.Doc();
            Y.applyUpdate(ydoc2, snapshot);

            // Phase 2: apply more edits to both
            for (const op of phase2) {
              if (op.tag === "edit") {
                ch.appendEdit(makeEdit(op.payload, "content", ts++));
                Y.applyUpdate(ydoc2, op.payload);
              } else {
                ch.closeEpoch();
              }
            }

            // Compare fold vs encode
            const measured = State.channelMeasured(codec);
            const cache = Cache.create<Uint8Array>();
            const foldResult = foldTree<Uint8Array>(measured, ch.tree, cache);
            const encodeResult = Y.encodeStateAsUpdate(ydoc2);

            expect(statesEqual(foldResult, encodeResult)).toBe(true);

            doc.destroy();
            ydoc.destroy();
            ydoc2.destroy();
          },
        ),
        { numRuns: 30 },
      );
    },
  );

  it(
    "empty document: fold and encode both " + "produce empty state",
    async () => {
      const identity = await generateIdentityKeypair();
      const doc = Document.create({
        identity,
        capability: fakeCap,
        codec,
      });
      const ch = doc.channel("content");

      const ydoc = new Y.Doc();

      const measured = State.channelMeasured(codec);
      const cache = Cache.create<Uint8Array>();
      const foldResult = foldTree<Uint8Array>(measured, ch.tree, cache);
      const encodeResult = Y.encodeStateAsUpdate(ydoc);

      expect(statesEqual(foldResult, encodeResult)).toBe(true);

      doc.destroy();
      ydoc.destroy();
    },
  );
});
