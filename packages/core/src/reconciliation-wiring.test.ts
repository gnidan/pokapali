import { describe, it, expect } from "vitest";
import { Channel, Edit } from "@pokapali/document";
import { toArray } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import type { ReconciliationTransport } from "@pokapali/sync";
import type { ReconciliationMessage } from "@pokapali/sync";
import { createReconciliationWiring } from "./reconciliation-wiring.js";

// -------------------------------------------------------
// Mock codec (identity CRDT: merge = last-write-wins)
// -------------------------------------------------------

function mockCodec(): Codec {
  return {
    empty(): Uint8Array {
      return new Uint8Array(0);
    },
    merge(a: Uint8Array, b: Uint8Array): Uint8Array {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    },
    // Unused by wiring — stubs for Codec interface
    diff() {
      return new Uint8Array(0);
    },
    apply(state: Uint8Array) {
      return state;
    },
    contains() {
      return false;
    },
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
    },
  } as Codec;
}

// -------------------------------------------------------
// Mock transport (queued in-memory message bus)
// -------------------------------------------------------

type MsgEntry = {
  channelName: string;
  msg: ReconciliationMessage;
};

function mockTransportPair(): {
  transportA: ReconciliationTransport;
  transportB: ReconciliationTransport;
  /** Deliver all queued messages until quiescent. */
  drain(): void;
} {
  const aCallbacks = new Set<
    (channelName: string, msg: ReconciliationMessage) => void
  >();
  const bCallbacks = new Set<
    (channelName: string, msg: ReconciliationMessage) => void
  >();

  // Queues: A→B and B→A
  const toB: MsgEntry[] = [];
  const toA: MsgEntry[] = [];

  function drain(): void {
    let rounds = 0;
    while (rounds < 200) {
      let progress = false;

      const batchToB = toB.splice(0);
      for (const e of batchToB) {
        for (const cb of bCallbacks) cb(e.channelName, e.msg);
        progress = true;
      }

      const batchToA = toA.splice(0);
      for (const e of batchToA) {
        for (const cb of aCallbacks) cb(e.channelName, e.msg);
        progress = true;
      }

      if (!progress) break;
      rounds++;
    }
    if (rounds >= 200) {
      throw new Error("drain did not converge");
    }
  }

  const transportA: ReconciliationTransport = {
    send(channelName: string, msg: ReconciliationMessage) {
      toB.push({ channelName, msg });
    },
    onMessage(cb: (channelName: string, msg: ReconciliationMessage) => void) {
      aCallbacks.add(cb);
      return () => aCallbacks.delete(cb);
    },
    get connected() {
      return true;
    },
    onConnectionChange() {
      return () => {};
    },
    destroy() {
      aCallbacks.clear();
    },
  };

  const transportB: ReconciliationTransport = {
    send(channelName: string, msg: ReconciliationMessage) {
      toA.push({ channelName, msg });
    },
    onMessage(cb: (channelName: string, msg: ReconciliationMessage) => void) {
      bCallbacks.add(cb);
      return () => bCallbacks.delete(cb);
    },
    get connected() {
      return true;
    },
    onConnectionChange() {
      return () => {};
    },
    destroy() {
      bCallbacks.clear();
    },
  };

  return { transportA, transportB, drain };
}

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

function collectPayloads(channel: Channel): Uint8Array[] {
  const epochs = toArray(channel.tree);
  const payloads: Uint8Array[] = [];
  for (const ep of epochs) {
    for (const e of ep.edits) {
      payloads.push(e.payload);
    }
  }
  return payloads;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("ReconciliationWiring", () => {
  it("edit on A appears on B after reconcile", () => {
    const chA = Channel.create("content");
    const chB = Channel.create("content");
    const editX = makeEdit(new Uint8Array([10, 20, 30]));
    chA.appendEdit(editX);

    const codec = mockCodec();
    const { transportA, transportB, drain } = mockTransportPair();

    const wiringA = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
      codec,
      transport: transportA,
    });
    const wiringB = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
      codec,
      transport: transportB,
    });

    wiringA.reconcile();
    wiringB.reconcile();
    drain();

    // B should now have A's edit
    const bPayloads = collectPayloads(chB);
    expect(bPayloads).toHaveLength(1);
    expect(bPayloads[0]).toEqual(editX.payload);

    wiringA.destroy();
    wiringB.destroy();
  });

  it("bidirectional: both sides receive " + "each other's edits", () => {
    const chA = Channel.create("content");
    const chB = Channel.create("content");
    const editX = makeEdit(new Uint8Array([10, 20, 30]));
    const editY = makeEdit(new Uint8Array([40, 50, 60]));
    chA.appendEdit(editX);
    chB.appendEdit(editY);

    const codec = mockCodec();
    const { transportA, transportB, drain } = mockTransportPair();

    const wiringA = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
      codec,
      transport: transportA,
    });
    const wiringB = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
      codec,
      transport: transportB,
    });

    wiringA.reconcile();
    wiringB.reconcile();
    drain();

    // A should have editY, B should have editX
    const aPayloads = collectPayloads(chA);
    const bPayloads = collectPayloads(chB);
    expect(aPayloads).toHaveLength(2);
    expect(bPayloads).toHaveLength(2);

    wiringA.destroy();
    wiringB.destroy();
  });

  it("dedup: same edit on both sides is not " + "applied again", () => {
    const shared = new Uint8Array([1, 2, 3]);
    const chA = Channel.create("content");
    const chB = Channel.create("content");
    chA.appendEdit(makeEdit(shared));
    chB.appendEdit(makeEdit(shared));

    const codec = mockCodec();
    const { transportA, transportB, drain } = mockTransportPair();

    const wiringA = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
      codec,
      transport: transportA,
    });
    const wiringB = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
      codec,
      transport: transportB,
    });

    wiringA.reconcile();
    wiringB.reconcile();
    drain();

    // Both should still have exactly 1 edit
    expect(collectPayloads(chA)).toHaveLength(1);
    expect(collectPayloads(chB)).toHaveLength(1);

    wiringA.destroy();
    wiringB.destroy();
  });

  it("destroy cleans up transport listener", () => {
    const chA = Channel.create("content");
    const codec = mockCodec();
    const { transportA } = mockTransportPair();

    const wiring = createReconciliationWiring({
      channels: ["content"],
      getChannel: () => chA,
      codec,
      transport: transportA,
    });

    wiring.reconcile();
    wiring.destroy();

    // After destroy, further messages should not
    // cause errors (transport listener removed)
    expect(() => wiring.destroy()).not.toThrow();
  });
});
