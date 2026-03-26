/**
 * Property tests for Document lifecycle state machine.
 *
 * Verifies invariants under random operation sequences:
 *   - Level tracking correctness
 *   - Activate/deactivate idempotency
 *   - View activation/deactivation consistency
 *   - New-channel view inheritance
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Codec } from "@pokapali/codec";
import { Document } from "./document.js";
import type { Level } from "./document.js";
import * as State from "#state";
import * as Fingerprint from "#fingerprint";
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

const LEVELS: Level[] = ["background", "active", "syncing", "inspecting"];

const LEVEL_INDEX: Record<Level, number> = {
  background: 0,
  active: 1,
  syncing: 2,
  inspecting: 3,
};

const levelArb = fc.constantFrom<Level>(...LEVELS);

const nonBgLevelArb = fc.constantFrom<Level>("active", "syncing", "inspecting");

type Op =
  | { type: "activate"; level: Level }
  | { type: "deactivate" }
  | { type: "channel"; name: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  levelArb.map((level) => ({ type: "activate", level }) as Op),
  fc.constant({ type: "deactivate" } as Op),
  fc
    .constantFrom("ch-a", "ch-b", "ch-c")
    .map((name) => ({ type: "channel", name }) as Op),
);

// -- Tests --

describe("Lifecycle property tests", () => {
  it("idempotency: activate(L); activate(L)" + " → level === L", () => {
    fc.assert(
      fc.property(nonBgLevelArb, (level) => {
        const doc = Document.create({
          identity: fakeIdentity(),
          capability: fakeCapability(),
          codec: fakeCodec(),
        });

        doc.activate(level);
        expect(doc.level).toBe(level);

        // Second call should be idempotent
        doc.activate(level);
        expect(doc.level).toBe(level);

        doc.destroy();
      }),
    );
  });

  it(
    "level ordering: doc.level equals most" +
      " recent activate or background after" +
      " deactivate",
    () => {
      fc.assert(
        fc.property(
          fc.array(opArb, {
            minLength: 1,
            maxLength: 50,
          }),
          (ops) => {
            const doc = Document.create({
              identity: fakeIdentity(),
              capability: fakeCapability(),
              codec: fakeCodec(),
            });

            let expected: Level = "background";

            for (const op of ops) {
              switch (op.type) {
                case "activate":
                  if (op.level !== "background") {
                    expected = op.level;
                  }
                  doc.activate(op.level);
                  break;
                case "deactivate":
                  expected = "background";
                  doc.deactivate();
                  break;
                case "channel":
                  doc.channel(op.name);
                  break;
              }
              expect(doc.level).toBe(expected);
            }

            doc.destroy();
          },
        ),
      );
    },
  );

  it(
    "step-up preserves lower views:" + " merged-payload survives syncing",
    () => {
      const codec = fakeCodec();
      const doc = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec,
      });

      const ch = doc.channel("content");
      ch.appendEdit(fakeEdit(1));

      // Activate to "active" — get merged-payload
      doc.activate("active");
      const feedA = ch.activate(State.view(codec));

      // Step up to "syncing"
      doc.activate("syncing");

      // merged-payload should be the same feed
      // (not destroyed and recreated)
      const feedB = ch.activate(State.view(codec));
      expect(feedB).toBe(feedA);

      doc.destroy();
    },
  );

  it(
    "step-down removes only higher views:" +
      " content-hash removed, merged-payload" +
      " preserved",
    () => {
      const codec = fakeCodec();
      const doc = Document.create({
        identity: fakeIdentity(),
        capability: fakeCapability(),
        codec,
      });

      const ch = doc.channel("content");
      ch.appendEdit(fakeEdit(1));

      // Activate to "syncing" — both views active
      doc.activate("syncing");
      const stateFeed = ch.activate(State.view(codec));
      const fpFeed = ch.activate(Fingerprint.view());

      // Step down to "active"
      doc.activate("active");

      // merged-payload preserved (same reference)
      const stateFeed2 = ch.activate(State.view(codec));
      expect(stateFeed2).toBe(stateFeed);

      // content-hash was deactivated — new feed
      const fpFeed2 = ch.activate(Fingerprint.view());
      expect(fpFeed2).not.toBe(fpFeed);

      doc.destroy();
    },
  );

  it(
    "new-channel view inheritance:" +
      " channel created at any level gets" +
      " exactly that level's views",
    () => {
      fc.assert(
        fc.property(nonBgLevelArb, (level) => {
          const codec = fakeCodec();
          const doc = Document.create({
            identity: fakeIdentity(),
            capability: fakeCapability(),
            codec,
          });

          doc.activate(level);

          // Create channel AFTER activation
          const ch = doc.channel("content");
          const idx = LEVEL_INDEX[level];

          // merged-payload should be active for
          // active and above
          if (idx >= LEVEL_INDEX["active"]) {
            const feed = ch.activate(State.view(codec));
            const snap = feed.getSnapshot();
            expect(snap.tag === "ready" || snap.tag === "stale").toBe(true);
          }

          // content-hash should be active for
          // syncing and above
          if (idx >= LEVEL_INDEX["syncing"]) {
            const feed = ch.activate(Fingerprint.view());
            const snap = feed.getSnapshot();
            expect(snap.tag === "ready" || snap.tag === "stale").toBe(true);
          }

          doc.destroy();
        }),
      );
    },
  );

  it(
    "random operation sequence model:" +
      " invariants hold after each operation",
    () => {
      fc.assert(
        fc.property(
          fc.array(opArb, {
            minLength: 1,
            maxLength: 100,
          }),
          (ops) => {
            const codec = fakeCodec();
            const doc = Document.create({
              identity: fakeIdentity(),
              capability: fakeCapability(),
              codec,
            });

            let expected: Level = "background";
            const channels = new Set<string>();

            for (const op of ops) {
              switch (op.type) {
                case "activate":
                  if (op.level !== "background") {
                    expected = op.level;
                  }
                  doc.activate(op.level);
                  break;
                case "deactivate":
                  expected = "background";
                  doc.deactivate();
                  break;
                case "channel":
                  doc.channel(op.name);
                  channels.add(op.name);
                  break;
              }

              // Invariant 1: level is correct
              expect(doc.level).toBe(expected);

              // Invariant 2: no throws on
              // channel access
              for (const name of channels) {
                expect(() => doc.channel(name)).not.toThrow();
              }
            }

            doc.destroy();
          },
        ),
      );
    },
  );
});
