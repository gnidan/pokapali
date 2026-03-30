import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { SignalType, encodeSignal, decodeSignal } from "./protocol.js";
import { createRoomRegistry, type RoomRegistry } from "./registry.js";
import {
  createRelayForwarder,
  RELAY_SIGNALING_TOPIC,
  type RelayForwarder,
} from "./relay-forward.js";

// -------------------------------------------------------
// Mock PubSub — shared bus for relay-to-relay tests
// -------------------------------------------------------

interface MockPubSub {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<void>;
  addEventListener(
    event: string,
    handler: (evt: { detail: { topic: string; data: Uint8Array } }) => void,
  ): void;
  removeEventListener(
    event: string,
    handler: (evt: { detail: { topic: string; data: Uint8Array } }) => void,
  ): void;
}

/**
 * Creates a shared PubSub bus that mimics GossipSub.
 * All subscribers on the same bus receive published
 * messages (including the publisher — echo).
 */
function createMockPubSubBus(): {
  createPubSub(): MockPubSub;
  /** Flush all pending deliveries */
  flush(): Promise<void>;
} {
  type Handler = (evt: { detail: { topic: string; data: Uint8Array } }) => void;

  const allHandlers = new Map<MockPubSub, Handler[]>();
  const pending: Promise<void>[] = [];

  function createPubSub(): MockPubSub {
    const handlers: Handler[] = [];
    const ps: MockPubSub = {
      subscribe() {},
      unsubscribe() {},
      async publish(topic: string, data: Uint8Array) {
        // Deliver to ALL subscribers on the bus
        // (including self — mimics GossipSub echo)
        for (const [, hs] of allHandlers) {
          for (const h of hs) {
            const p = Promise.resolve().then(() =>
              h({ detail: { topic, data } }),
            );
            pending.push(p);
          }
        }
      },
      addEventListener(_event: string, handler: Handler) {
        handlers.push(handler);
      },
      removeEventListener(_event: string, handler: Handler) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      },
    };
    allHandlers.set(ps, handlers);
    return ps;
  }

  async function flush(): Promise<void> {
    // Drain pending deliveries, including cascading
    // publishes from response broadcasts.
    for (let i = 0; i < 20; i++) {
      if (pending.length === 0) {
        // One more tick to pick up any microtasks
        await new Promise<void>((r) => setTimeout(r, 0));
        if (pending.length === 0) break;
      }
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  }

  return { createPubSub, flush };
}

// -------------------------------------------------------
// Helper: collect messages sent to a local peer
// -------------------------------------------------------

function createLocalPeer(
  peerId: string,
  registry: RoomRegistry,
  room: string,
): {
  received: Uint8Array[];
  entry: { peerId: string; send: (b: Uint8Array) => void };
} {
  const received: Uint8Array[] = [];
  const entry = {
    peerId,
    send: (bytes: Uint8Array) => received.push(bytes),
  };
  registry.join(room, entry);
  return { received, entry };
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("relay-to-relay forwarding", () => {
  let bus: ReturnType<typeof createMockPubSubBus>;

  beforeEach(() => {
    bus = createMockPubSubBus();
  });

  describe("basic two-relay routing", () => {
    let reg1: RoomRegistry;
    let reg2: RoomRegistry;
    let fwd1: RelayForwarder;
    let fwd2: RelayForwarder;
    let ps1: MockPubSub;
    let ps2: MockPubSub;

    beforeEach(() => {
      reg1 = createRoomRegistry();
      reg2 = createRoomRegistry();
      ps1 = bus.createPubSub();
      ps2 = bus.createPubSub();
      fwd1 = createRelayForwarder(ps1, "relay-1", reg1);
      fwd2 = createRelayForwarder(ps2, "relay-2", reg2);
    });

    afterEach(() => {
      fwd1.stop();
      fwd2.stop();
    });

    it("remote peer appears after join broadcast", async () => {
      // Peer A is local to relay 1
      const peerA = createLocalPeer("peer-a", reg1, "room1");
      void peerA;

      // Peer B joins relay 2
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Relay 1 should now have peer-b as a member
      const members = reg1.members("room1");
      const peerIds = members.map((m) => m.peerId);
      expect(peerIds).toContain("peer-b");
    });

    it("local peer receives PEER_JOINED for " + "remote peer", async () => {
      // Peer A is local to relay 1
      const peerA = createLocalPeer("peer-a", reg1, "room1");

      // Peer B joins relay 2
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Peer A should have received PEER_JOINED
      expect(peerA.received.length).toBeGreaterThan(0);
      const msg = decodeSignal(peerA.received[0]!);
      expect(msg.type).toBe(SignalType.PEER_JOINED);
      if (msg.type === SignalType.PEER_JOINED) {
        expect(msg.peerId).toBe("peer-b");
        expect(msg.room).toBe("room1");
      }
    });

    it("remote peer discovers existing local " + "members", async () => {
      // Peer A already in room on relay 1
      createLocalPeer("peer-a", reg1, "room1");
      fwd1.onLocalJoin("room1", "peer-a");
      await bus.flush();

      // Peer B joins relay 2
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Relay 2 should have peer-a as a member
      // (the handler tells peer-b about existing
      //  members via registry.members — here we
      //  verify the forwarder added the virtual
      //  entry so the handler CAN find it)
      const members = reg2.members("room1");
      const peerIds = members.map((m) => m.peerId);
      expect(peerIds).toContain("peer-a");
      expect(peerIds).toContain("peer-b");
    });

    it("signal routes from local to remote peer", async () => {
      // Peer A on relay 1
      createLocalPeer("peer-a", reg1, "room1");
      fwd1.onLocalJoin("room1", "peer-a");

      // Peer B on relay 2
      const peerB = createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Clear any join notifications
      peerB.received.length = 0;

      // Relay 1 routes signal from A to B
      // (handler would call sendTo which calls
      //  virtual entry.send)
      const virtualB = reg1.findPeer("room1", "peer-b");
      expect(virtualB).toBeDefined();
      const signalPayload = encodeSignal({
        type: SignalType.SIGNAL,
        room: "room1",
        targetPeerId: "peer-a",
        payload: new Uint8Array([1, 2, 3]),
      });
      virtualB!.send(signalPayload);
      await bus.flush();

      // Peer B should receive the signal
      expect(peerB.received.length).toBeGreaterThan(0);
      // The received bytes are the raw signal payload
      expect(peerB.received[0]).toEqual(signalPayload);
    });

    it("PEER_LEFT sent when remote peer leaves", async () => {
      // Both peers in room
      const peerA = createLocalPeer("peer-a", reg1, "room1");
      fwd1.onLocalJoin("room1", "peer-a");
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Clear join notifications
      peerA.received.length = 0;

      // Peer B leaves
      fwd2.onLocalLeave("room1", "peer-b");
      await bus.flush();

      // Peer A should receive PEER_LEFT
      expect(peerA.received.length).toBeGreaterThan(0);
      const msg = decodeSignal(peerA.received[peerA.received.length - 1]!);
      expect(msg.type).toBe(SignalType.PEER_LEFT);
      if (msg.type === SignalType.PEER_LEFT) {
        expect(msg.peerId).toBe("peer-b");
      }
    });

    it("isRemotePeer distinguishes local vs remote", async () => {
      createLocalPeer("peer-a", reg1, "room1");
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      expect(fwd1.isRemotePeer("peer-a")).toBe(false);
      expect(fwd1.isRemotePeer("peer-b")).toBe(true);
      expect(fwd1.isRemotePeer("unknown")).toBe(false);
    });
  });

  describe("echo suppression", () => {
    it("relay ignores its own GossipSub echo", async () => {
      const reg = createRoomRegistry();
      const ps = bus.createPubSub();
      const fwd = createRelayForwarder(ps, "relay-1", reg);

      const peerA = createLocalPeer("peer-a", reg, "room1");
      fwd.onLocalJoin("room1", "peer-a");
      await bus.flush();

      // Peer A should NOT receive PEER_JOINED for
      // itself (that would be the echo)
      const selfJoins = peerA.received
        .map((b) => decodeSignal(b))
        .filter(
          (m) => m.type === SignalType.PEER_JOINED && m.peerId === "peer-a",
        );
      expect(selfJoins).toHaveLength(0);

      fwd.stop();
    });
  });

  describe("dedup", () => {
    it("duplicate REMOTE_JOIN for same peer is " + "ignored", async () => {
      const reg1 = createRoomRegistry();
      const reg2 = createRoomRegistry();
      const ps1 = bus.createPubSub();
      const ps2 = bus.createPubSub();
      const fwd1 = createRelayForwarder(ps1, "relay-1", reg1);
      const fwd2 = createRelayForwarder(ps2, "relay-2", reg2);

      const peerA = createLocalPeer("peer-a", reg1, "room1");

      createLocalPeer("peer-b", reg2, "room1");
      // Broadcast join twice
      fwd2.onLocalJoin("room1", "peer-b");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Peer A should receive PEER_JOINED only once
      const joinMsgs = peerA.received
        .map((b) => decodeSignal(b))
        .filter(
          (m) => m.type === SignalType.PEER_JOINED && m.peerId === "peer-b",
        );
      expect(joinMsgs).toHaveLength(1);

      fwd1.stop();
      fwd2.stop();
    });
  });

  describe("room isolation", () => {
    it("signals don't leak across rooms", async () => {
      const reg1 = createRoomRegistry();
      const reg2 = createRoomRegistry();
      const ps1 = bus.createPubSub();
      const ps2 = bus.createPubSub();
      const fwd1 = createRelayForwarder(ps1, "relay-1", reg1);
      const fwd2 = createRelayForwarder(ps2, "relay-2", reg2);

      // Peer A in room-x on relay 1
      createLocalPeer("peer-a", reg1, "room-x");
      fwd1.onLocalJoin("room-x", "peer-a");

      // Peer B in room-y on relay 2
      const peerB = createLocalPeer("peer-b", reg2, "room-y");
      fwd2.onLocalJoin("room-y", "peer-b");
      await bus.flush();

      // Peer B should NOT get PEER_JOINED for
      // peer-a (different room)
      const joinMsgs = peerB.received
        .map((b) => decodeSignal(b))
        .filter(
          (m) => m.type === SignalType.PEER_JOINED && m.peerId === "peer-a",
        );
      expect(joinMsgs).toHaveLength(0);

      fwd1.stop();
      fwd2.stop();
    });
  });

  describe("three-relay topology", () => {
    it("all peers discover each other across " + "three relays", async () => {
      const regs = [
        createRoomRegistry(),
        createRoomRegistry(),
        createRoomRegistry(),
      ];
      const pubs = [bus.createPubSub(), bus.createPubSub(), bus.createPubSub()];
      const fwds = [
        createRelayForwarder(pubs[0]!, "relay-0", regs[0]!),
        createRelayForwarder(pubs[1]!, "relay-1", regs[1]!),
        createRelayForwarder(pubs[2]!, "relay-2", regs[2]!),
      ];

      // Peer on each relay
      createLocalPeer("peer-a", regs[0]!, "room1");
      fwds[0]!.onLocalJoin("room1", "peer-a");
      await bus.flush();

      createLocalPeer("peer-b", regs[1]!, "room1");
      fwds[1]!.onLocalJoin("room1", "peer-b");
      await bus.flush();

      createLocalPeer("peer-c", regs[2]!, "room1");
      fwds[2]!.onLocalJoin("room1", "peer-c");
      await bus.flush();

      // Each relay should see all three peers
      for (let i = 0; i < 3; i++) {
        const members = regs[i]!.members("room1")
          .map((m) => m.peerId)
          .sort();
        expect(members).toEqual(["peer-a", "peer-b", "peer-c"]);
      }

      for (const f of fwds) f.stop();
    });

    it("late joiner sees existing peers", async () => {
      const regs = [
        createRoomRegistry(),
        createRoomRegistry(),
        createRoomRegistry(),
      ];
      const pubs = [bus.createPubSub(), bus.createPubSub(), bus.createPubSub()];
      const fwds = [
        createRelayForwarder(pubs[0]!, "relay-0", regs[0]!),
        createRelayForwarder(pubs[1]!, "relay-1", regs[1]!),
        createRelayForwarder(pubs[2]!, "relay-2", regs[2]!),
      ];

      // A and B join first
      createLocalPeer("peer-a", regs[0]!, "room1");
      fwds[0]!.onLocalJoin("room1", "peer-a");
      createLocalPeer("peer-b", regs[1]!, "room1");
      fwds[1]!.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // C joins late
      createLocalPeer("peer-c", regs[2]!, "room1");
      fwds[2]!.onLocalJoin("room1", "peer-c");
      await bus.flush();

      // All relays should see all three peers.
      // (The handler would tell C about existing
      //  members via registry.members() — that's
      //  handler logic, not forwarder logic.)
      for (let i = 0; i < 3; i++) {
        const members = regs[i]!.members("room1")
          .map((m) => m.peerId)
          .sort();
        expect(members).toEqual(["peer-a", "peer-b", "peer-c"]);
      }

      for (const f of fwds) f.stop();
    });
  });

  describe("edge cases", () => {
    it("leave before any remote knows about peer", async () => {
      const reg1 = createRoomRegistry();
      const reg2 = createRoomRegistry();
      const ps1 = bus.createPubSub();
      const ps2 = bus.createPubSub();
      const fwd1 = createRelayForwarder(ps1, "relay-1", reg1);
      const fwd2 = createRelayForwarder(ps2, "relay-2", reg2);

      createLocalPeer("peer-a", reg1, "room1");

      // Join and immediately leave (handler removes
      // from registry before broadcasting leave)
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      reg2.leave("room1", "peer-b");
      fwd2.onLocalLeave("room1", "peer-b");
      await bus.flush();

      // Relay 1 should not have peer-b (or have
      // removed it)
      const hasB = reg1.members("room1").some((m) => m.peerId === "peer-b");
      expect(hasB).toBe(false);

      fwd1.stop();
      fwd2.stop();
    });

    it("stop() cleans up event listeners", async () => {
      const reg = createRoomRegistry();
      const ps = bus.createPubSub();
      const fwd = createRelayForwarder(ps, "relay-1", reg);

      createLocalPeer("peer-a", reg, "room1");
      fwd.stop();

      // After stop, broadcasts from other relays
      // should not affect this registry
      const reg2 = createRoomRegistry();
      const ps2 = bus.createPubSub();
      const fwd2 = createRelayForwarder(ps2, "relay-2", reg2);
      createLocalPeer("peer-b", reg2, "room1");
      fwd2.onLocalJoin("room1", "peer-b");
      await bus.flush();

      // Relay 1's registry should NOT have peer-b
      const hasB = reg.members("room1").some((m) => m.peerId === "peer-b");
      expect(hasB).toBe(false);

      fwd2.stop();
    });

    it("signal to unknown remote peer is " + "silently dropped", async () => {
      const reg1 = createRoomRegistry();
      const reg2 = createRoomRegistry();
      const ps1 = bus.createPubSub();
      const ps2 = bus.createPubSub();
      const fwd1 = createRelayForwarder(ps1, "relay-1", reg1);
      const fwd2 = createRelayForwarder(ps2, "relay-2", reg2);

      createLocalPeer("peer-a", reg1, "room1");
      fwd1.onLocalJoin("room1", "peer-a");
      await bus.flush();

      // Try sending signal to non-existent peer
      const virtualA = reg2.findPeer("room1", "peer-a");
      expect(virtualA).toBeDefined();
      // This should not throw
      virtualA!.send(
        encodeSignal({
          type: SignalType.SIGNAL,
          room: "room1",
          targetPeerId: "ghost",
          payload: new Uint8Array([99]),
        }),
      );
      await bus.flush();

      fwd1.stop();
      fwd2.stop();
    });
  });

  describe("property tests", () => {
    it(
      "random join/leave sequences: all live " + "peers discover each other",
      async () => {
        // Action: join or leave a peer on a relay
        const arbAction = fc.oneof(
          fc.record({
            type: fc.constant("join" as const),
            relay: fc.integer({ min: 0, max: 2 }),
            peer: fc.integer({ min: 0, max: 4 }),
          }),
          fc.record({
            type: fc.constant("leave" as const),
            relay: fc.integer({ min: 0, max: 2 }),
            peer: fc.integer({ min: 0, max: 4 }),
          }),
        );

        await fc.assert(
          fc.asyncProperty(
            fc.array(arbAction, {
              minLength: 1,
              maxLength: 20,
            }),
            async (actions) => {
              const b = createMockPubSubBus();
              const regs = [
                createRoomRegistry(),
                createRoomRegistry(),
                createRoomRegistry(),
              ];
              const pubs = [
                b.createPubSub(),
                b.createPubSub(),
                b.createPubSub(),
              ];
              const fwds = [
                createRelayForwarder(pubs[0]!, "r0", regs[0]!),
                createRelayForwarder(pubs[1]!, "r1", regs[1]!),
                createRelayForwarder(pubs[2]!, "r2", regs[2]!),
              ];

              // Track ground truth: which peers are
              // actually in the room
              const truth = new Map<string, number>();
              // peer -> relay index

              for (const action of actions) {
                const pid = `p${action.peer}`;
                const rid = action.relay;

                if (action.type === "join") {
                  // If already joined on different
                  // relay, leave first
                  if (truth.has(pid)) {
                    const oldRelay = truth.get(pid)!;
                    regs[oldRelay]!.leave("room", pid);
                    fwds[oldRelay]!.onLocalLeave("room", pid);
                  }
                  truth.set(pid, rid);
                  regs[rid]!.join("room", {
                    peerId: pid,
                    send: () => {},
                  });
                  fwds[rid]!.onLocalJoin("room", pid);
                } else {
                  if (truth.has(pid)) {
                    const oldRelay = truth.get(pid)!;
                    regs[oldRelay]!.leave("room", pid);
                    fwds[oldRelay]!.onLocalLeave("room", pid);
                    truth.delete(pid);
                  }
                }

                await b.flush();
              }

              // After all actions, each relay should
              // see all live peers
              const expectedPeers = [...truth.keys()].sort();

              for (let i = 0; i < 3; i++) {
                const actual = regs[i]!.members("room")
                  .map((m) => m.peerId)
                  .sort();
                // All expected peers must appear
                for (const ep of expectedPeers) {
                  expect(actual).toContain(ep);
                }
              }

              for (const f of fwds) f.stop();
            },
          ),
          { numRuns: 100 },
        );
      },
      30_000,
    );
  });
});
