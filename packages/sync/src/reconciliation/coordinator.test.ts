import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { Channel, Edit } from "@pokapali/document";
import { type Message, MessageType } from "./messages.js";
import {
  createCoordinator,
  type MessageSender,
  type EditApplier,
  type CoordinatorOptions,
} from "./coordinator.js";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeEdit(payload: Uint8Array, channel = "content"): Edit {
  return Edit.create({
    payload,
    timestamp: Date.now(),
    author: "test-author",
    channel,
    origin: "local",
    signature: new Uint8Array([1, 2, 3, 4]),
  });
}

function mockSender(): MessageSender & {
  messages: Message[];
} {
  const messages: Message[] = [];
  return {
    send(msg: Message) {
      messages.push(msg);
    },
    messages,
  };
}

function mockApplier(): EditApplier & {
  applied: Edit[];
  snapshots: Uint8Array[];
} {
  const applied: Edit[] = [];
  const snapshots: Uint8Array[] = [];
  return {
    apply(edit: Edit) {
      applied.push(edit);
    },
    applySnapshot(snapshot: Uint8Array) {
      snapshots.push(snapshot);
    },
    applied,
    snapshots,
  };
}

function hexHash(h: Uint8Array): string {
  return Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Drive a full bidirectional exchange between two
 * coordinators. Returns the number of rounds taken.
 */
function runExchange(
  coordA: ReturnType<typeof createCoordinator>,
  senderA: { messages: Message[] },
  coordB: ReturnType<typeof createCoordinator>,
  senderB: { messages: Message[] },
): number {
  coordA.start();
  coordB.start();
  let rounds = 0;

  while (rounds < 200) {
    let progress = false;

    // Deliver A's outgoing messages to B
    const fromA = senderA.messages.splice(0);
    for (const msg of fromA) {
      coordB.receive(msg);
      progress = true;
    }

    // Deliver B's outgoing messages to A
    const fromB = senderB.messages.splice(0);
    for (const msg of fromB) {
      coordA.receive(msg);
      progress = true;
    }

    if (!progress) break;
    rounds++;
  }

  if (rounds >= 200) {
    throw new Error("Exchange did not converge in 200 rounds");
  }

  return rounds;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("ReconciliationCoordinator", () => {
  describe("bidirectional exchange", () => {
    it(
      "A has edit X, B has edit Y — " + "each receives the other's edit",
      () => {
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const editX = makeEdit(new Uint8Array([10, 20, 30]));
        const editY = makeEdit(new Uint8Array([40, 50, 60]));
        chA.appendEdit(editX);
        chB.appendEdit(editY);

        const senderA = mockSender();
        const senderB = mockSender();
        const applierA = mockApplier();
        const applierB = mockApplier();

        const coordA = createCoordinator({
          channel: chA,
          channelName: "content",
          sender: senderA,
          applier: applierA,
        });
        const coordB = createCoordinator({
          channel: chB,
          channelName: "content",
          sender: senderB,
          applier: applierB,
        });

        runExchange(coordA, senderA, coordB, senderB);

        // A should receive edit Y
        expect(applierA.applied).toHaveLength(1);
        expect(applierA.applied[0]!.payload).toEqual(editY.payload);

        // B should receive edit X
        expect(applierB.applied).toHaveLength(1);
        expect(applierB.applied[0]!.payload).toEqual(editX.payload);
      },
    );
  });

  describe("late joiner", () => {
    it(
      "A has 0 edits, B has edits + snapshot " + "— A receives FULL_STATE",
      () => {
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        chB.appendEdit(makeEdit(new Uint8Array([1, 2, 3])));
        chB.appendEdit(makeEdit(new Uint8Array([4, 5, 6])));

        const snapshot = new Uint8Array([99, 98, 97, 96]);

        const senderA = mockSender();
        const senderB = mockSender();
        const applierA = mockApplier();
        const applierB = mockApplier();

        const coordA = createCoordinator({
          channel: chA,
          channelName: "content",
          sender: senderA,
          applier: applierA,
        });
        const coordB = createCoordinator({
          channel: chB,
          channelName: "content",
          sender: senderB,
          applier: applierB,
          localSnapshot: snapshot,
        });

        runExchange(coordA, senderA, coordB, senderB);

        // A receives the snapshot via applySnapshot
        expect(applierA.snapshots).toHaveLength(1);
        expect(applierA.snapshots[0]).toEqual(snapshot);
      },
    );
  });

  describe("identical peers", () => {
    it("both have same edits — no edits applied", () => {
      const editPayload = new Uint8Array([1, 2, 3]);
      const chA = Channel.create("content");
      const chB = Channel.create("content");
      chA.appendEdit(makeEdit(editPayload));
      chB.appendEdit(makeEdit(editPayload));

      const senderA = mockSender();
      const senderB = mockSender();
      const applierA = mockApplier();
      const applierB = mockApplier();

      const coordA = createCoordinator({
        channel: chA,
        channelName: "content",
        sender: senderA,
        applier: applierA,
      });
      const coordB = createCoordinator({
        channel: chB,
        channelName: "content",
        sender: senderB,
        applier: applierB,
      });

      runExchange(coordA, senderA, coordB, senderB);

      expect(applierA.applied).toHaveLength(0);
      expect(applierB.applied).toHaveLength(0);
    });
  });

  describe("signature rejection", () => {
    it(
      "edit with empty signature is rejected " +
        "when trustedKeys is non-empty",
      () => {
        const chA = Channel.create("content");
        const chB = Channel.create("content");

        // A has an edit with an empty signature
        const unsignedEdit = Edit.create({
          payload: new Uint8Array([7, 8, 9]),
          timestamp: Date.now(),
          author: "some-key",
          channel: "content",
          origin: "local",
          signature: new Uint8Array(), // empty!
        });
        chA.appendEdit(unsignedEdit);

        const senderA = mockSender();
        const senderB = mockSender();
        const applierA = mockApplier();
        const applierB = mockApplier();

        const coordA = createCoordinator({
          channel: chA,
          channelName: "content",
          sender: senderA,
          applier: applierA,
        });
        const coordB = createCoordinator({
          channel: chB,
          channelName: "content",
          sender: senderB,
          applier: applierB,
          trustedKeys: new Set(["some-key"]),
        });

        runExchange(coordA, senderA, coordB, senderB);

        // B should NOT have applied the unsigned edit
        expect(applierB.applied).toHaveLength(0);
      },
    );
  });

  describe("deduplication", () => {
    it("same edit already in channel is not " + "applied again", () => {
      const shared = new Uint8Array([1, 2, 3]);
      const extra = new Uint8Array([4, 5, 6]);

      const chA = Channel.create("content");
      const chB = Channel.create("content");
      chA.appendEdit(makeEdit(shared));
      chA.appendEdit(makeEdit(extra));
      chB.appendEdit(makeEdit(shared));

      const senderA = mockSender();
      const senderB = mockSender();
      const applierA = mockApplier();
      const applierB = mockApplier();

      const coordA = createCoordinator({
        channel: chA,
        channelName: "content",
        sender: senderA,
        applier: applierA,
      });
      const coordB = createCoordinator({
        channel: chB,
        channelName: "content",
        sender: senderB,
        applier: applierB,
      });

      runExchange(coordA, senderA, coordB, senderB);

      // B should only receive `extra`, not `shared`
      expect(applierB.applied).toHaveLength(1);
      expect(applierB.applied[0]!.payload).toEqual(extra);
    });
  });

  describe("coordinator.done", () => {
    it("true after both directions complete", () => {
      const chA = Channel.create("content");
      const chB = Channel.create("content");
      chA.appendEdit(makeEdit(new Uint8Array([1, 2, 3])));
      chB.appendEdit(makeEdit(new Uint8Array([4, 5, 6])));

      const senderA = mockSender();
      const senderB = mockSender();
      const applierA = mockApplier();
      const applierB = mockApplier();

      const coordA = createCoordinator({
        channel: chA,
        channelName: "content",
        sender: senderA,
        applier: applierA,
      });
      const coordB = createCoordinator({
        channel: chB,
        channelName: "content",
        sender: senderB,
        applier: applierB,
      });

      expect(coordA.done).toBe(false);
      expect(coordB.done).toBe(false);

      runExchange(coordA, senderA, coordB, senderB);

      expect(coordA.done).toBe(true);
      expect(coordB.done).toBe(true);
    });
  });
});
