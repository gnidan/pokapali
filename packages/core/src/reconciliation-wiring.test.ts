import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { Channel, Edit, State, Cache, foldTree } from "@pokapali/document";
import { toArray } from "@pokapali/finger-tree";
import type { Codec } from "@pokapali/codec";
import {
  generateIdentityKeypair,
  bytesToHex,
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/blocks";
import type { ReconciliationTransport, SnapshotMessage } from "@pokapali/sync";
import type { ReconciliationMessage } from "@pokapali/sync";
import { ReconciliationMessageType } from "@pokapali/sync";
import { createReconciliationWiring } from "./reconciliation-wiring.js";
import type { BlockResolver } from "./block-resolver.js";
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
  const aSnapCallbacks = new Set<(msg: SnapshotMessage) => void>();
  const bSnapCallbacks = new Set<(msg: SnapshotMessage) => void>();

  // Queues: A→B and B→A. Snapshot messages ride
  // alongside with channelName === "" (signaling
  // they should fan out to snapshot callbacks).
  const toB: MsgEntry[] = [];
  const toA: MsgEntry[] = [];
  const snapToB: SnapshotMessage[] = [];
  const snapToA: SnapshotMessage[] = [];

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

      const snapBatchToB = snapToB.splice(0);
      for (const msg of snapBatchToB) {
        for (const cb of bSnapCallbacks) cb(msg);
        progress = true;
      }

      const snapBatchToA = snapToA.splice(0);
      for (const msg of snapBatchToA) {
        for (const cb of aSnapCallbacks) cb(msg);
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
    sendSnapshotMessage(msg: SnapshotMessage) {
      snapToB.push(msg);
    },
    onMessage(cb: (channelName: string, msg: ReconciliationMessage) => void) {
      aCallbacks.add(cb);
      return () => aCallbacks.delete(cb);
    },
    onSnapshotMessage(cb: (msg: SnapshotMessage) => void) {
      aSnapCallbacks.add(cb);
      return () => aSnapCallbacks.delete(cb);
    },
    get connected() {
      return true;
    },
    onConnectionChange() {
      return () => {};
    },
    destroy() {
      aCallbacks.clear();
      aSnapCallbacks.clear();
    },
  };

  const transportB: ReconciliationTransport = {
    send(channelName: string, msg: ReconciliationMessage) {
      toA.push({ channelName, msg });
    },
    sendSnapshotMessage(msg: SnapshotMessage) {
      snapToA.push(msg);
    },
    onMessage(cb: (channelName: string, msg: ReconciliationMessage) => void) {
      bCallbacks.add(cb);
      return () => bCallbacks.delete(cb);
    },
    onSnapshotMessage(cb: (msg: SnapshotMessage) => void) {
      bSnapCallbacks.add(cb);
      return () => bSnapCallbacks.delete(cb);
    },
    get connected() {
      return true;
    },
    onConnectionChange() {
      return () => {};
    },
    destroy() {
      bCallbacks.clear();
      bSnapCallbacks.clear();
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

  it(
    "onReconcileCycleEnd fires once per cycle " +
      "after all coordinators report done",
    () => {
      const chA = Channel.create("content");
      const chB = Channel.create("content");
      // Both sides carry distinct edits so each
      // coordinator's bidirectional exchange completes
      // and transitions to done.
      chA.appendEdit(makeEdit(new Uint8Array([1])));
      chB.appendEdit(makeEdit(new Uint8Array([2])));

      const codec = mockCodec();
      const { transportA, transportB, drain } = mockTransportPair();

      let cycleEndA = 0;
      let cycleEndB = 0;

      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: transportA,
        onReconcileCycleEnd: () => {
          cycleEndA++;
        },
      });
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        onReconcileCycleEnd: () => {
          cycleEndB++;
        },
      });

      wiringA.reconcile();
      wiringB.reconcile();
      drain();

      // Each side fires exactly once per completed
      // reconcile cycle — not once per received
      // message.
      expect(cycleEndA).toBe(1);
      expect(cycleEndB).toBe(1);

      // A second reconcile re-arms the latch. Add new
      // edits so both sides still converge this round.
      chA.appendEdit(makeEdit(new Uint8Array([3])));
      chB.appendEdit(makeEdit(new Uint8Array([4])));
      wiringA.reconcile();
      wiringB.reconcile();
      drain();

      expect(cycleEndA).toBe(2);
      expect(cycleEndB).toBe(2);

      wiringA.destroy();
      wiringB.destroy();
    },
  );

  it("onReconcileCycleEnd swallows callback throws", () => {
    const chA = Channel.create("content");
    const chB = Channel.create("content");
    chA.appendEdit(makeEdit(new Uint8Array([1])));
    chB.appendEdit(makeEdit(new Uint8Array([2])));

    const codec = mockCodec();
    const { transportA, transportB, drain } = mockTransportPair();

    const wiringA = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
      codec,
      transport: transportA,
      onReconcileCycleEnd: () => {
        throw new Error("boom");
      },
    });
    const wiringB = createReconciliationWiring({
      channels: ["content"],
      getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
      codec,
      transport: transportB,
    });

    wiringA.reconcile();
    wiringB.reconcile();

    // A throwing callback must not break the reconcile
    // loop — drain() should still complete normally.
    expect(() => drain()).not.toThrow();

    wiringA.destroy();
    wiringB.destroy();
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

  describe("incoming edit verification", () => {
    it("valid envelope is verified and applied", async () => {
      const kp = await generateIdentityKeypair();
      const pubHex = bytesToHex(kp.publicKey);

      const chA = Channel.create("content");
      const chB = Channel.create("content");
      // Shared edit on both sides so neither is a
      // late joiner (avoids FULL_STATE shortcut).
      const shared = makeEdit(new Uint8Array([1, 2, 3]));
      chA.appendEdit(shared);
      chB.appendEdit(shared);
      // A has an extra edit that B needs
      const editX = makeEdit(new Uint8Array([10, 20, 30]));
      chA.appendEdit(editX);

      const codec = mockCodec();
      const { transportA, transportB, drain } = mockTransportPair();

      // A signs outgoing edits
      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: transportA,
        identity: kp,
      });
      // B trusts A's key and verifies incoming
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        trustedKeys: new Set([pubHex]),
      });

      wiringA.reconcile();
      wiringB.reconcile();

      // Drain sync protocol, flush async signing,
      // drain signed EDIT_BATCH, flush async
      // verification.
      drain();
      await new Promise((r) => setTimeout(r, 50));
      drain();
      await new Promise((r) => setTimeout(r, 50));

      const bPayloads = collectPayloads(chB);
      // shared + editX
      expect(bPayloads).toHaveLength(2);
      expect(
        bPayloads.some(
          (p) =>
            p.length === editX.payload.length &&
            p.every((b, i) => b === editX.payload[i]),
        ),
      ).toBe(true);

      wiringA.destroy();
      wiringB.destroy();
    });

    it("tampered envelope is rejected", async () => {
      const kp = await generateIdentityKeypair();
      const pubHex = bytesToHex(kp.publicKey);

      const chA = Channel.create("content");
      const chB = Channel.create("content");
      // Shared edit so neither is a late joiner
      const shared = makeEdit(new Uint8Array([1, 2, 3]));
      chA.appendEdit(shared);
      chB.appendEdit(shared);
      const editX = makeEdit(new Uint8Array([10, 20, 30]));
      chA.appendEdit(editX);

      const codec = mockCodec();
      const { transportA, transportB, drain } = mockTransportPair();

      // Intercept A's transport to tamper with
      // the envelope before B sees it.
      const tamperingTransportA: ReconciliationTransport = {
        ...transportA,
        send(ch: string, msg: ReconciliationMessage) {
          if (msg.type === ReconciliationMessageType.EDIT_BATCH) {
            // Flip a byte in the signature to
            // invalidate it.
            const tampered = {
              ...msg,
              edits: msg.edits.map((e) => {
                if (e.signature.length < HEADER_SIZE) {
                  return e;
                }
                const bad = new Uint8Array(e.signature);
                bad[HEADER_SIZE - 1]! ^= 0xff;
                return {
                  payload: e.payload,
                  signature: bad,
                };
              }),
            };
            transportA.send(ch, tampered);
          } else {
            transportA.send(ch, msg);
          }
        },
      };

      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: tamperingTransportA,
        identity: kp,
      });
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        trustedKeys: new Set([pubHex]),
      });

      wiringA.reconcile();
      wiringB.reconcile();
      drain();
      await new Promise((r) => setTimeout(r, 50));
      drain();
      await new Promise((r) => setTimeout(r, 50));

      // B should only have the shared edit, not
      // the tampered one
      const bPayloads = collectPayloads(chB);
      expect(bPayloads).toHaveLength(1);
      expect(bPayloads[0]).toEqual(shared.payload);

      wiringA.destroy();
      wiringB.destroy();
    });

    it("untrusted key envelope is rejected", async () => {
      const kpA = await generateIdentityKeypair();
      const kpOther = await generateIdentityKeypair();
      const otherHex = bytesToHex(kpOther.publicKey);

      const chA = Channel.create("content");
      const chB = Channel.create("content");
      // Shared edit so neither is a late joiner
      const shared = makeEdit(new Uint8Array([1, 2, 3]));
      chA.appendEdit(shared);
      chB.appendEdit(shared);
      const editX = makeEdit(new Uint8Array([10, 20, 30]));
      chA.appendEdit(editX);

      const codec = mockCodec();
      const { transportA, transportB, drain } = mockTransportPair();

      // A signs with kpA but B only trusts kpOther
      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: transportA,
        identity: kpA,
      });
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        trustedKeys: new Set([otherHex]),
      });

      wiringA.reconcile();
      wiringB.reconcile();
      drain();
      await new Promise((r) => setTimeout(r, 50));
      drain();
      await new Promise((r) => setTimeout(r, 50));

      // B should only have the shared edit, not
      // the one signed by untrusted kpA
      const bPayloads = collectPayloads(chB);
      expect(bPayloads).toHaveLength(1);
      expect(bPayloads[0]).toEqual(shared.payload);

      wiringA.destroy();
      wiringB.destroy();
    });

    it("raw/legacy signature falls through " + "without verification", () => {
      // No identity on A → raw 4-byte sig
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
        // No identity — raw signatures
      });
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        // trustedKeys set, but raw sigs bypass
        // envelope verification
        trustedKeys: new Set(["some-key"]),
      });

      wiringA.reconcile();
      wiringB.reconcile();
      drain();

      // B applies the edit — raw sig passes through
      const bPayloads = collectPayloads(chB);
      expect(bPayloads).toHaveLength(1);
      expect(bPayloads[0]).toEqual(editX.payload);

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

  // -----------------------------------------------------
  // Snapshot exchange tests (S53 B3)
  // -----------------------------------------------------

  describe("snapshot exchange", () => {
    const DAG_CBOR_CODE = 0x71;

    function mockBlockResolver(): BlockResolver & {
      stored: Map<string, Uint8Array>;
    } {
      const stored = new Map<string, Uint8Array>();
      return {
        stored,
        get: async (cid) => stored.get(cid.toString()) ?? null,
        has: (cid) => stored.has(cid.toString()),
        getCached: (cid) => stored.get(cid.toString()) ?? null,
        put: (cid, block) => {
          stored.set(cid.toString(), block);
        },
      };
    }

    async function makeValidBlock(
      text: string,
      seq: number,
    ): Promise<{ cid: CID; block: Uint8Array }> {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test-app", ["content"]);
      const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
      const ydoc = new Y.Doc();
      ydoc.getText("content").insert(0, text);
      const state = Y.encodeStateAsUpdate(ydoc);
      const block = await encodeSnapshot(
        { content: state },
        keys.readKey,
        null,
        seq,
        Date.now(),
        signingKey,
      );
      const hash = await sha256.digest(block);
      const cid = CID.createV1(DAG_CBOR_CODE, hash);
      return { cid, block };
    }

    it(
      "advertises local catalog once all " + "coordinators report done",
      () => {
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        // Shared edit so neither side is a late joiner
        // (late-joiner path skips the inDone flip on
        // the FULL_STATE path, which would defeat the
        // "all coordinators done" check here).
        const shared = makeEdit(new Uint8Array([1, 2, 3]));
        chA.appendEdit(shared);
        chB.appendEdit(shared);

        const codec = mockCodec();
        const { transportA, transportB, drain } = mockTransportPair();

        const catalogCid = new Uint8Array([0xaa, 0xbb, 0xcc]);
        const catalogA = {
          entries: [{ cid: catalogCid, seq: 1, ts: 100 }],
          tip: catalogCid,
        };

        // Track outgoing snapshot messages from A.
        const sentSnapshots: SnapshotMessage[] = [];
        const wrappedTransportA: ReconciliationTransport = {
          ...transportA,
          sendSnapshotMessage: (msg) => {
            sentSnapshots.push(msg);
            transportA.sendSnapshotMessage(msg);
          },
        };

        const resolverA = mockBlockResolver();
        const resolverB = mockBlockResolver();

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: wrappedTransportA,
          getSnapshotCatalog: () => catalogA,
          blockResolver: resolverA,
        });
        const wiringB = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chB : Channel.create(name),
          codec,
          transport: transportB,
          getSnapshotCatalog: () => ({ entries: [], tip: null }),
          blockResolver: resolverB,
        });

        wiringA.reconcile();
        wiringB.reconcile();
        drain();

        // A should have advertised exactly once after
        // its coordinator reached `done`.
        const catalogs = sentSnapshots.filter(
          (m) => m.type === ReconciliationMessageType.SNAPSHOT_CATALOG,
        );
        expect(catalogs.length).toBe(1);
        if (catalogs[0]!.type !== ReconciliationMessageType.SNAPSHOT_CATALOG) {
          throw new Error();
        }
        expect(catalogs[0]!.entries).toHaveLength(1);
        expect(catalogs[0]!.tip).toEqual(catalogCid);

        wiringA.destroy();
        wiringB.destroy();
      },
    );

    it(
      "transfers a valid snapshot block: " +
        "request → serve → verify → blockResolver.put + " +
        "onSnapshotReceived",
      async () => {
        const { cid, block } = await makeValidBlock("hello world", 1);

        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const shared = makeEdit(new Uint8Array([1, 2, 3]));
        chA.appendEdit(shared);
        chB.appendEdit(shared);

        const codec = mockCodec();
        const { transportA, transportB, drain } = mockTransportPair();

        const resolverA = mockBlockResolver();
        // Prime A's cache with the block it can serve.
        resolverA.put(cid, block);

        const resolverB = mockBlockResolver();
        const receivedByB: Array<{ cid: CID; data: Uint8Array }> = [];

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: transportA,
          getSnapshotCatalog: () => ({
            entries: [{ cid: cid.bytes, seq: 1, ts: Date.now() }],
            tip: cid.bytes,
          }),
          blockResolver: resolverA,
        });
        const wiringB = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chB : Channel.create(name),
          codec,
          transport: transportB,
          getSnapshotCatalog: () => ({ entries: [], tip: null }),
          blockResolver: resolverB,
          onSnapshotReceived: (c, d) => receivedByB.push({ cid: c, data: d }),
        });

        wiringA.reconcile();
        wiringB.reconcile();

        // Drain edit exchange, let async verify settle,
        // drain snapshot-request → block reply, let
        // async verify complete again, drain callbacks.
        drain();
        await new Promise((r) => setTimeout(r, 30));
        drain();
        await new Promise((r) => setTimeout(r, 30));
        drain();

        // B stored the block via blockResolver.put and
        // fired onSnapshotReceived with matching bytes.
        // Compare byte-wise: encodeSnapshot returns a
        // Buffer but reassembly produces a Uint8Array,
        // and `toEqual` distinguishes the two even when
        // bytes match.
        const storedB = resolverB.stored.get(cid.toString());
        expect(storedB).toBeDefined();
        expect(Array.from(storedB!)).toEqual(Array.from(block));
        expect(receivedByB).toHaveLength(1);
        expect(receivedByB[0]!.cid.toString()).toBe(cid.toString());
        expect(Array.from(receivedByB[0]!.data)).toEqual(Array.from(block));

        wiringA.destroy();
        wiringB.destroy();
      },
    );

    it("rejects a block whose CID hash doesn't " + "match", async () => {
      const { cid, block } = await makeValidBlock("real", 1);
      // Corrupt the block bytes so sha256(block) no
      // longer matches the CID's multihash digest.
      const corrupted = new Uint8Array(block);
      corrupted[corrupted.length - 1]! ^= 0xff;

      const chA = Channel.create("content");
      const chB = Channel.create("content");
      const shared = makeEdit(new Uint8Array([1, 2, 3]));
      chA.appendEdit(shared);
      chB.appendEdit(shared);

      const codec = mockCodec();
      const { transportA, transportB, drain } = mockTransportPair();

      const resolverA = mockBlockResolver();
      // Prime A with corrupted bytes but advertise the
      // real CID — B will verify and reject.
      resolverA.stored.set(cid.toString(), corrupted);

      const resolverB = mockBlockResolver();
      const receivedByB: Array<{ cid: CID; data: Uint8Array }> = [];

      const wiringA = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chA : Channel.create(name)),
        codec,
        transport: transportA,
        getSnapshotCatalog: () => ({
          entries: [{ cid: cid.bytes, seq: 1, ts: Date.now() }],
          tip: cid.bytes,
        }),
        blockResolver: resolverA,
      });
      const wiringB = createReconciliationWiring({
        channels: ["content"],
        getChannel: (name) => (name === "content" ? chB : Channel.create(name)),
        codec,
        transport: transportB,
        getSnapshotCatalog: () => ({ entries: [], tip: null }),
        blockResolver: resolverB,
        onSnapshotReceived: (c, d) => receivedByB.push({ cid: c, data: d }),
      });

      wiringA.reconcile();
      wiringB.reconcile();
      drain();
      await new Promise((r) => setTimeout(r, 30));
      drain();
      await new Promise((r) => setTimeout(r, 30));
      drain();

      // Verification failed — block not stored, callback
      // not fired.
      expect(resolverB.stored.has(cid.toString())).toBe(false);
      expect(receivedByB).toHaveLength(0);

      wiringA.destroy();
      wiringB.destroy();
    });

    it(
      "rejects a block whose signature is " +
        "invalid (validateSnapshot fails)",
      async () => {
        const { block } = await makeValidBlock("real", 1);
        // Tamper bytes inside the signed payload, then
        // recompute the CID so the hash check passes but
        // validateSnapshot fails (signature no longer
        // matches the tampered payload).
        const tampered = new Uint8Array(block);
        // Flip a byte early in the block (inside the
        // signed ciphertext region).
        tampered[10]! ^= 0xff;
        const hash = await sha256.digest(tampered);
        const tamperedCid = CID.createV1(DAG_CBOR_CODE, hash);

        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const shared = makeEdit(new Uint8Array([1, 2, 3]));
        chA.appendEdit(shared);
        chB.appendEdit(shared);

        const codec = mockCodec();
        const { transportA, transportB, drain } = mockTransportPair();

        const resolverA = mockBlockResolver();
        resolverA.put(tamperedCid, tampered);

        const resolverB = mockBlockResolver();
        const receivedByB: Array<{ cid: CID; data: Uint8Array }> = [];

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: transportA,
          getSnapshotCatalog: () => ({
            entries: [{ cid: tamperedCid.bytes, seq: 1, ts: Date.now() }],
            tip: tamperedCid.bytes,
          }),
          blockResolver: resolverA,
        });
        const wiringB = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chB : Channel.create(name),
          codec,
          transport: transportB,
          getSnapshotCatalog: () => ({ entries: [], tip: null }),
          blockResolver: resolverB,
          onSnapshotReceived: (c, d) => receivedByB.push({ cid: c, data: d }),
        });

        wiringA.reconcile();
        wiringB.reconcile();
        drain();
        await new Promise((r) => setTimeout(r, 30));
        drain();
        await new Promise((r) => setTimeout(r, 30));
        drain();

        expect(resolverB.stored.has(tamperedCid.toString())).toBe(false);
        expect(receivedByB).toHaveLength(0);

        wiringA.destroy();
        wiringB.destroy();
      },
    );

    it(
      "catalog producer filters entries by " +
        "resolver availability (A4 §catalog-producer)",
      () => {
        // Simulates the create-doc.ts catalog
        // lambda: only entries whose blocks exist
        // in the resolver appear in the catalog.
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const shared = makeEdit(new Uint8Array([1, 2, 3]));
        chA.appendEdit(shared);
        chB.appendEdit(shared);

        const codec = mockCodec();
        const { transportA, transportB, drain } = mockTransportPair();

        const resolverA = mockBlockResolver();
        const resolverB = mockBlockResolver();

        // Two CID entries: one available in
        // resolver, one not.
        const availableCid = new Uint8Array([
          0x01,
          0x71,
          0x12,
          0x20,
          ...Array(32).fill(0xaa),
        ]);
        const missingCid = new Uint8Array([
          0x01,
          0x71,
          0x12,
          0x20,
          ...Array(32).fill(0xbb),
        ]);
        // Put block for availableCid so
        // resolver.has returns true
        const fakeCid = CID.decode(availableCid);
        resolverA.put(fakeCid, new Uint8Array([99]));

        const sentSnapshots: SnapshotMessage[] = [];
        const wrappedTransportA: ReconciliationTransport = {
          ...transportA,
          sendSnapshotMessage: (msg) => {
            sentSnapshots.push(msg);
            transportA.sendSnapshotMessage(msg);
          },
        };

        // Catalog function mimics the create-doc
        // lambda: filter by has().
        const allRecords = [
          {
            cid: availableCid,
            seq: 1,
            ts: 100,
          },
          {
            cid: missingCid,
            seq: 2,
            ts: 200,
          },
        ];

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: wrappedTransportA,
          getSnapshotCatalog: () => ({
            entries: allRecords.filter((r) => {
              try {
                const c = CID.decode(r.cid);
                return resolverA.has(c);
              } catch {
                return false;
              }
            }),
            tip: availableCid,
          }),
          blockResolver: resolverA,
        });
        const wiringB = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chB : Channel.create(name),
          codec,
          transport: transportB,
          getSnapshotCatalog: () => ({
            entries: [],
            tip: null,
          }),
          blockResolver: resolverB,
        });

        wiringA.reconcile();
        wiringB.reconcile();
        drain();

        const catalogs = sentSnapshots.filter(
          (m) => m.type === ReconciliationMessageType.SNAPSHOT_CATALOG,
        );
        expect(catalogs.length).toBe(1);
        if (catalogs[0]!.type !== ReconciliationMessageType.SNAPSHOT_CATALOG) {
          throw new Error();
        }
        // Only the available entry is advertised.
        expect(catalogs[0]!.entries).toHaveLength(1);
        expect(catalogs[0]!.entries[0]!.seq).toBe(1);

        wiringA.destroy();
        wiringB.destroy();
      },
    );

    it(
      "no snapshot exchange when " +
        "getSnapshotCatalog/blockResolver are absent",
      () => {
        const chA = Channel.create("content");
        const chB = Channel.create("content");
        const shared = makeEdit(new Uint8Array([1, 2, 3]));
        chA.appendEdit(shared);
        chB.appendEdit(shared);

        const codec = mockCodec();
        const { transportA, transportB, drain } = mockTransportPair();

        const sentSnapshots: SnapshotMessage[] = [];
        const wrappedTransportA: ReconciliationTransport = {
          ...transportA,
          sendSnapshotMessage: (msg) => {
            sentSnapshots.push(msg);
            transportA.sendSnapshotMessage(msg);
          },
        };

        const wiringA = createReconciliationWiring({
          channels: ["content"],
          getChannel: (name) =>
            name === "content" ? chA : Channel.create(name),
          codec,
          transport: wrappedTransportA,
          // No getSnapshotCatalog / blockResolver →
          // snapshot exchange disabled.
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
        drain();

        expect(sentSnapshots).toHaveLength(0);

        wiringA.destroy();
        wiringB.destroy();
      },
    );
  });
});
