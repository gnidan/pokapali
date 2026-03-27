/**
 * Property tests for Document view activation.
 *
 * Verifies invariants under random operation sequences:
 *   - Activate/deactivate idempotency
 *   - View activation/deactivation consistency
 *   - New-channel view inheritance
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Codec } from "@pokapali/codec";
import { Document } from "./document.js";
import * as State from "#state";
import * as Fingerprint from "#fingerprint";
import { View } from "../view.js";
import { Edit } from "#history";

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
      const c = new Uint8Array([...a, ...b]);
      c.sort();
      return c;
    },
    diff: (state, base) => {
      const s = new Set(base);
      return new Uint8Array([...state].filter((b) => !s.has(b)));
    },
    apply: (base, update) => {
      const c = new Uint8Array([...base, ...update]);
      c.sort();
      return c;
    },
    empty: () => new Uint8Array([]),
    contains: (snap, edit) => {
      const id = edit[0]!;
      for (const b of snap) {
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

function fakeEdit(id: number) {
  return Edit.create({
    payload: new Uint8Array([id]),
    timestamp: Date.now(),
    author: "aabb",
    channel: "content",
    origin: "local",
    signature: new Uint8Array([id]),
  });
}

const codec = fakeCodec();
const stateView = State.view(codec);
const fpView = Fingerprint.view();
const views = [stateView, fpView];

const viewArb = fc.constantFrom(...views);

type Op =
  | { type: "activate"; view: View<unknown> }
  | { type: "deactivate"; viewName: string }
  | { type: "channel"; name: string }
  | { type: "edit"; id: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  viewArb.map((view) => ({ type: "activate", view }) as Op),
  fc.constantFrom("merged-payload", "content-hash").map(
    (viewName) =>
      ({
        type: "deactivate",
        viewName,
      }) as Op,
  ),
  fc
    .constantFrom("content", "comments", "extra")
    .map((name) => ({ type: "channel", name }) as Op),
  fc.nat(255).map((id) => ({ type: "edit", id }) as Op),
);

// -- Tests --

describe("View activation property tests", () => {
  it(
    "idempotency: activate(v); activate(v) " + "returns consistent snapshots",
    () => {
      fc.assert(
        fc.property(viewArb, (view) => {
          const doc = Document.create({
            identity: fakeIdentity(),
            capability: fakeCapability(),
          });

          const feed1 = doc.activate(view);
          expect(feed1.getSnapshot().tag).toBe("ready");

          // Second call returns same snapshot ref
          const feed2 = doc.activate(view);
          expect(feed2.getSnapshot()).toBe(feed1.getSnapshot());

          doc.destroy();
        }),
      );
    },
  );

  it("deactivate + re-activate produces a " + "fresh feed", () => {
    fc.assert(
      fc.property(viewArb, (view) => {
        const doc = Document.create({
          identity: fakeIdentity(),
          capability: fakeCapability(),
        });

        doc.channel("content");
        const feed1 = doc.activate(view);
        const snap1 = feed1.getSnapshot();

        doc.deactivate(view.name);
        const feed2 = doc.activate(view);

        // New feed — might be same value but
        // different Status object
        expect(feed2.getSnapshot().tag).toBe("ready");

        doc.destroy();
      }),
    );
  });

  it("random operation sequence: no throws", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, {
          minLength: 1,
          maxLength: 100,
        }),
        (ops) => {
          const doc = Document.create({
            identity: fakeIdentity(),
            capability: fakeCapability(),
          });

          for (const op of ops) {
            switch (op.type) {
              case "activate":
                doc.activate(op.view);
                break;
              case "deactivate":
                doc.deactivate(op.viewName);
                break;
              case "channel":
                doc.channel(op.name);
                break;
              case "edit":
                doc.channel("content").appendEdit(fakeEdit(op.id));
                break;
            }
          }

          doc.destroy();
        },
      ),
    );
  });

  it("channel creation order does not affect " + "view result", () => {
    const doc1 = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });
    const doc2 = Document.create({
      identity: fakeIdentity(),
      capability: fakeCapability(),
    });

    // doc1: channel then activate
    doc1.channel("content").appendEdit(fakeEdit(1));
    const feed1 = doc1.activate(stateView);

    // doc2: activate then channel
    const feed2 = doc2.activate(stateView);
    doc2.channel("content").appendEdit(fakeEdit(1));

    const snap1 = feed1.getSnapshot();
    const snap2 = feed2.getSnapshot();

    expect(snap1.tag).toBe("ready");
    expect(snap2.tag).toBe("ready");
    if (snap1.tag === "ready" && snap2.tag === "ready") {
      expect(snap1.value).toEqual(snap2.value);
    }

    doc1.destroy();
    doc2.destroy();
  });
});
