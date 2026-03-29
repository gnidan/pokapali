import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  encodeSignal,
  decodeSignal,
  SignalType,
  type SignalMessage,
} from "./protocol.js";

// -------------------------------------------------------
// Arbitraries
// -------------------------------------------------------

const roomArb = fc.string({
  minLength: 1,
  maxLength: 100,
});
const peerIdArb = fc.string({
  minLength: 1,
  maxLength: 80,
});
const payloadArb = fc.uint8Array({
  minLength: 0,
  maxLength: 500,
});

const arbJoinRoom = fc.record({
  type: fc.constant(SignalType.JOIN_ROOM),
  room: roomArb,
});

const arbLeaveRoom = fc.record({
  type: fc.constant(SignalType.LEAVE_ROOM),
  room: roomArb,
});

const arbSignal = fc.record({
  type: fc.constant(SignalType.SIGNAL),
  room: roomArb,
  targetPeerId: peerIdArb,
  payload: payloadArb,
});

const arbPeerJoined = fc.record({
  type: fc.constant(SignalType.PEER_JOINED),
  room: roomArb,
  peerId: peerIdArb,
});

const arbPeerLeft = fc.record({
  type: fc.constant(SignalType.PEER_LEFT),
  room: roomArb,
  peerId: peerIdArb,
});

const arbMessage: fc.Arbitrary<SignalMessage> = fc.oneof(
  arbJoinRoom,
  arbLeaveRoom,
  arbSignal,
  arbPeerJoined,
  arbPeerLeft,
);

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function deepEqualMsg(a: SignalMessage, b: SignalMessage): void {
  expect(a.type).toBe(b.type);

  switch (a.type) {
    case SignalType.JOIN_ROOM: {
      const bb = b as typeof a;
      expect(a.room).toBe(bb.room);
      break;
    }
    case SignalType.LEAVE_ROOM: {
      const bb = b as typeof a;
      expect(a.room).toBe(bb.room);
      break;
    }
    case SignalType.SIGNAL: {
      const bb = b as typeof a;
      expect(a.room).toBe(bb.room);
      expect(a.targetPeerId).toBe(bb.targetPeerId);
      expect(a.payload).toEqual(bb.payload);
      break;
    }
    case SignalType.PEER_JOINED: {
      const bb = b as typeof a;
      expect(a.room).toBe(bb.room);
      expect(a.peerId).toBe(bb.peerId);
      break;
    }
    case SignalType.PEER_LEFT: {
      const bb = b as typeof a;
      expect(a.room).toBe(bb.room);
      expect(a.peerId).toBe(bb.peerId);
      break;
    }
  }
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("signaling protocol messages", () => {
  describe("round-trip property tests", () => {
    it("any message survives encode/decode", () => {
      fc.assert(
        fc.property(arbMessage, (msg) => {
          const bytes = encodeSignal(msg);
          const decoded = decodeSignal(bytes);
          deepEqualMsg(msg, decoded);
        }),
        { numRuns: 500 },
      );
    });

    it("JoinRoom round-trip", () => {
      fc.assert(
        fc.property(arbJoinRoom, (msg) => {
          deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("LeaveRoom round-trip", () => {
      fc.assert(
        fc.property(arbLeaveRoom, (msg) => {
          deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("Signal round-trip", () => {
      fc.assert(
        fc.property(arbSignal, (msg) => {
          deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("PeerJoined round-trip", () => {
      fc.assert(
        fc.property(arbPeerJoined, (msg) => {
          deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("PeerLeft round-trip", () => {
      fc.assert(
        fc.property(arbPeerLeft, (msg) => {
          deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("edge cases", () => {
    it("empty payload in Signal", () => {
      const msg: SignalMessage = {
        type: SignalType.SIGNAL,
        room: "test-room",
        targetPeerId: "peer-123",
        payload: new Uint8Array(0),
      };
      deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
    });

    it("large payload in Signal", () => {
      const msg: SignalMessage = {
        type: SignalType.SIGNAL,
        room: "room",
        targetPeerId: "peer",
        payload: new Uint8Array(10000).fill(0xab),
      };
      deepEqualMsg(msg, decodeSignal(encodeSignal(msg)));
    });

    it("unknown signal type throws", () => {
      const enc = new Uint8Array([99]);
      expect(() => decodeSignal(enc)).toThrow(/Unknown signal type/);
    });
  });
});
