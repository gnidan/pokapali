import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Channel, Edit, State, Cache, foldTree } from "@pokapali/document";
import { toArray } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import { generateIdentityKeypair, bytesToHex } from "@pokapali/crypto";
import type { ReconciliationTransport } from "@pokapali/sync";
import type { ReconciliationMessage } from "@pokapali/sync";
import { ReconciliationMessageType } from "@pokapali/sync";
import { createReconciliationWiring } from "./reconciliation-wiring.js";
import { verifyEdit, HEADER_SIZE } from "./epoch/sign-edit.js";

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

  describe("outgoing edit signing", () => {
    it(
      "EDIT_BATCH messages carry signed envelopes " +
        "when identity is provided",
      async () => {
        const kp = await generateIdentityKeypair();
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const editX = makeEdit(new Uint8Array([10, 20, 30]));
        chA.appendEdit(editX);

        const codec = mockCodec();

        // Capture outgoing messages from A's
        // transport to inspect signatures.
        const sentByA: ReconciliationMessage[] = [];
        const { transportA, transportB, drain } = mockTransportPair();
        const wrappedTransportA: ReconciliationTransport = {
          ...transportA,
          send(ch: string, msg: ReconciliationMessage) {
            sentByA.push(msg);
            transportA.send(ch, msg);
          },
        };

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: wrappedTransportA,
          identity: kp,
        });
        const wiringB = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chB : Channel.create(name),
          codec,
          transport: transportB,
        });

        wiringA.reconcile();
        wiringB.reconcile();

        // Signing is async — drain the synchronous
        // protocol messages first, then flush microtasks
        // to let signing complete before draining the
        // signed EDIT_BATCH.
        drain();
        await new Promise((r) => setTimeout(r, 50));
        drain();

        // Find EDIT_BATCH messages sent by A
        const batches = sentByA.filter(
          (m) => m.type === ReconciliationMessageType.EDIT_BATCH,
        );
        expect(batches.length).toBeGreaterThan(0);

        for (const batch of batches) {
          if (batch.type !== ReconciliationMessageType.EDIT_BATCH) {
            continue;
          }
          for (const e of batch.edits) {
            // Signature should be a 97+ byte envelope
            expect(e.signature.length).toBeGreaterThanOrEqual(HEADER_SIZE);
            // Verify the envelope is valid
            const result = await verifyEdit(e.signature);
            expect(result).not.toBeNull();
            // Envelope's embedded payload matches the
            // edit payload
            expect(result!.payload).toEqual(e.payload);
            // Signer matches our keypair
            expect(bytesToHex(result!.pubkey)).toBe(bytesToHex(kp.publicKey));
          }
        }

        wiringA.destroy();
        wiringB.destroy();
      },
    );

    it("without identity, signatures are unchanged", () => {
      const chA = Channel.create("content");
      const chB = Channel.create("content");
      const sig = new Uint8Array([1, 2, 3, 4]);
      const editX = Edit.create({
        payload: new Uint8Array([10, 20, 30]),
        timestamp: Date.now(),
        author: "test",
        channel: "content",
        origin: "local",
        signature: sig,
      });
      chA.appendEdit(editX);

      const codec = mockCodec();
      const sentByA: ReconciliationMessage[] = [];
      const { transportA, transportB, drain } = mockTransportPair();
      const wrappedTransportA: ReconciliationTransport = {
        ...transportA,
        send(ch: string, msg: ReconciliationMessage) {
          sentByA.push(msg);
          transportA.send(ch, msg);
        },
      };

      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: wrappedTransportA,
        // No identity — signatures pass through
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

      const batches = sentByA.filter(
        (m) => m.type === ReconciliationMessageType.EDIT_BATCH,
      );
      expect(batches.length).toBeGreaterThan(0);

      for (const batch of batches) {
        if (batch.type !== ReconciliationMessageType.EDIT_BATCH) {
          continue;
        }
        for (const e of batch.edits) {
          // Original signature passed through
          expect(e.signature).toEqual(sig);
        }
      }

      wiringA.destroy();
      wiringB.destroy();
    });
  });

  describe("property tests", () => {
    function hexPayload(p: Uint8Array): string {
      return Array.from(p)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    const channelNameArb = fc.stringMatching(/^[a-z]{1,10}$/);
    const payloadArb = fc.uint8Array({
      minLength: 1,
      maxLength: 50,
    });

    it(
      "multi-channel: N channels converge " +
        "independently, no cross-channel leaks",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(channelNameArb, {
              minLength: 2,
              maxLength: 4,
            }),
            fc.uniqueArray(payloadArb, {
              minLength: 0,
              maxLength: 30,
              selector: (p) => Array.from(p).join(","),
            }),
            (channelNames, allPayloads) => {
              // Distribute payloads round-robin across
              // channels, alternating A/B. Some channels
              // may end up with 0 edits on one side,
              // exercising the FULL_STATE late-joiner
              // path.
              const perChannel = new Map<
                string,
                {
                  onlyA: Uint8Array[];
                  onlyB: Uint8Array[];
                }
              >();
              for (const name of channelNames) {
                perChannel.set(name, {
                  onlyA: [],
                  onlyB: [],
                });
              }
              for (let i = 0; i < allPayloads.length; i++) {
                const chName = channelNames[i % channelNames.length]!;
                const bucket = perChannel.get(chName)!;
                if (i % 2 === 0) {
                  bucket.onlyA.push(allPayloads[i]!);
                } else {
                  bucket.onlyB.push(allPayloads[i]!);
                }
              }

              // Build channels for A and B
              const channelsA = new Map<string, Channel>();
              const channelsB = new Map<string, Channel>();
              for (const name of channelNames) {
                const chA = Channel.create(name);
                const chB = Channel.create(name);
                const { onlyA, onlyB } = perChannel.get(name)!;
                for (const p of onlyA) {
                  chA.appendEdit(makeEdit(p, name));
                }
                for (const p of onlyB) {
                  chB.appendEdit(makeEdit(p, name));
                }
                channelsA.set(name, chA);
                channelsB.set(name, chB);
              }

              const codec = mockCodec();
              const { transportA, transportB, drain } = mockTransportPair();

              const wiringA = createReconciliationWiring({
                channels: channelNames,
                getChannel: (name) => channelsA.get(name)!,
                codec,
                transport: transportA,
              });
              const wiringB = createReconciliationWiring({
                channels: channelNames,
                getChannel: (name) => channelsB.get(name)!,
                codec,
                transport: transportB,
              });

              wiringA.reconcile();
              wiringB.reconcile();
              drain();

              // Convergence: both sides have the same
              // total payload bytes per channel. We
              // compare fold LENGTHS (not bytes)
              // because the concat-merge codec is
              // order-sensitive and edit insertion
              // order differs between peers. Length
              // is order-independent for concat.
              const measured = State.channelMeasured(codec);
              for (const name of channelNames) {
                const lenA = foldTree<Uint8Array>(
                  measured,
                  channelsA.get(name)!.tree,
                  Cache.create<Uint8Array>(),
                ).length;
                const lenB = foldTree<Uint8Array>(
                  measured,
                  channelsB.get(name)!.tree,
                  Cache.create<Uint8Array>(),
                ).length;
                expect(lenA).toBe(lenB);
              }

              // No cross-channel leaks: folded state
              // length per channel must equal the sum
              // of all payload lengths for that
              // channel (and no more).
              for (const name of channelNames) {
                const { onlyA, onlyB } = perChannel.get(name)!;
                const expectedLen = [...onlyA, ...onlyB].reduce(
                  (n, p) => n + p.length,
                  0,
                );
                const actualLen = foldTree<Uint8Array>(
                  measured,
                  channelsA.get(name)!.tree,
                  Cache.create<Uint8Array>(),
                ).length;
                expect(actualLen).toBe(expectedLen);
              }

              wiringA.destroy();
              wiringB.destroy();
            },
          ),
          { numRuns: 200 },
        );
      },
    );
  });
});
