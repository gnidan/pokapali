import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import {
  createPeerManager,
  encodeWebRTCSignal,
  decodeWebRTCSignal,
  WebRTCSignalType,
} from "./peer-connection.js";
import type { WebRTCSignal } from "./peer-connection.js";
import type { SignalingClient } from "./client.js";

// -------------------------------------------------------
// Sub-protocol encoding tests
// -------------------------------------------------------

describe("WebRTC signal encoding", () => {
  it("round-trips SDP offer", () => {
    const sdp = { type: "offer", sdp: "v=0..." };
    const bytes = encodeWebRTCSignal({
      type: WebRTCSignalType.SDP_OFFER,
      sdp,
    });
    const decoded = decodeWebRTCSignal(bytes);
    expect(decoded.type).toBe(WebRTCSignalType.SDP_OFFER);
    if (decoded.type === WebRTCSignalType.SDP_OFFER) {
      expect(decoded.sdp).toEqual(sdp);
    }
  });

  it("round-trips SDP answer", () => {
    const sdp = { type: "answer", sdp: "v=0..." };
    const bytes = encodeWebRTCSignal({
      type: WebRTCSignalType.SDP_ANSWER,
      sdp,
    });
    const decoded = decodeWebRTCSignal(bytes);
    expect(decoded.type).toBe(WebRTCSignalType.SDP_ANSWER);
    if (decoded.type === WebRTCSignalType.SDP_ANSWER) {
      expect(decoded.sdp).toEqual(sdp);
    }
  });

  it("round-trips ICE candidate", () => {
    const candidate = {
      candidate: "candidate:...",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const bytes = encodeWebRTCSignal({
      type: WebRTCSignalType.ICE_CANDIDATE,
      candidate,
    });
    const decoded = decodeWebRTCSignal(bytes);
    expect(decoded.type).toBe(WebRTCSignalType.ICE_CANDIDATE);
    if (decoded.type === WebRTCSignalType.ICE_CANDIDATE) {
      expect(decoded.candidate).toEqual(candidate);
    }
  });
});

describe("WebRTC signal decode robustness", () => {
  it("throws descriptive error on corrupt JSON", () => {
    // discriminant byte + invalid JSON
    const corrupt = new Uint8Array([
      WebRTCSignalType.SDP_OFFER,
      ...new TextEncoder().encode("{not valid json"),
    ]);
    expect(() => decodeWebRTCSignal(corrupt)).toThrow(
      /malformed WebRTC signal/i,
    );
  });

  it("throws on empty payload (no JSON)", () => {
    const empty = new Uint8Array([WebRTCSignalType.SDP_OFFER]);
    expect(() => decodeWebRTCSignal(empty)).toThrow(/malformed WebRTC signal/i);
  });

  it("throws on unknown signal type", () => {
    const unknown = new Uint8Array([0xff, ...new TextEncoder().encode("{}")]);
    expect(() => decodeWebRTCSignal(unknown)).toThrow(
      /unknown WebRTC signal type/i,
    );
  });
});

describe("WebRTC signal encoding (property)", () => {
  const arbSdpSignal: fc.Arbitrary<WebRTCSignal> = fc.record({
    type: fc.constantFrom(
      WebRTCSignalType.SDP_OFFER,
      WebRTCSignalType.SDP_ANSWER,
    ) as fc.Arbitrary<
      typeof WebRTCSignalType.SDP_OFFER | typeof WebRTCSignalType.SDP_ANSWER
    >,
    sdp: fc.record({
      type: fc.string(),
      sdp: fc.string(),
    }),
  });

  const arbIceSignal: fc.Arbitrary<WebRTCSignal> = fc.record({
    type: fc.constant(WebRTCSignalType.ICE_CANDIDATE) as fc.Arbitrary<
      typeof WebRTCSignalType.ICE_CANDIDATE
    >,
    candidate: fc.record({
      candidate: fc.string(),
      sdpMid: fc.option(fc.string(), {
        nil: null,
      }),
      sdpMLineIndex: fc.option(fc.integer(), {
        nil: null,
      }),
    }),
  });

  const arbSignal = fc.oneof(arbSdpSignal, arbIceSignal);

  it("round-trips arbitrary signals", () => {
    fc.assert(
      fc.property(arbSignal, (signal) => {
        const bytes = encodeWebRTCSignal(signal);
        const decoded = decodeWebRTCSignal(bytes);
        expect(decoded).toEqual(signal);
      }),
      { numRuns: 200 },
    );
  });

  it("first byte is the discriminant", () => {
    fc.assert(
      fc.property(arbSignal, (signal) => {
        const bytes = encodeWebRTCSignal(signal);
        expect(bytes[0]).toBe(signal.type);
      }),
      { numRuns: 100 },
    );
  });
});

// -------------------------------------------------------
// Mock SignalingClient
// -------------------------------------------------------

function createMockSignalingClient(): {
  client: SignalingClient;
  firePeerJoined: (room: string, peerId: string) => void;
  firePeerLeft: (room: string, peerId: string) => void;
  fireSignal: (room: string, fromPeerId: string, payload: Uint8Array) => void;
  fireClose: () => void;
} {
  const peerJoinedCbs = new Set<(room: string, peerId: string) => void>();
  const peerLeftCbs = new Set<(room: string, peerId: string) => void>();
  const signalCbs = new Set<
    (room: string, fromPeerId: string, payload: Uint8Array) => void
  >();
  const closeCbs = new Set<() => void>();

  return {
    client: {
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      sendSignal: vi.fn(),
      onPeerJoined(cb) {
        peerJoinedCbs.add(cb);
        return () => peerJoinedCbs.delete(cb);
      },
      onPeerLeft(cb) {
        peerLeftCbs.add(cb);
        return () => peerLeftCbs.delete(cb);
      },
      onSignal(cb) {
        signalCbs.add(cb);
        return () => signalCbs.delete(cb);
      },
      onClose(cb) {
        closeCbs.add(cb);
        return () => closeCbs.delete(cb);
      },
      destroy: vi.fn(),
    },
    firePeerJoined(room, peerId) {
      for (const cb of peerJoinedCbs) {
        cb(room, peerId);
      }
    },
    firePeerLeft(room, peerId) {
      for (const cb of peerLeftCbs) {
        cb(room, peerId);
      }
    },
    fireSignal(room, fromPeerId, payload) {
      for (const cb of signalCbs) {
        cb(room, fromPeerId, payload);
      }
    },
    fireClose() {
      for (const cb of closeCbs) cb();
    },
  };
}

// -------------------------------------------------------
// Mock RTCPeerConnection
// -------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unsafe-function-type */
function createMockPC() {
  const pc = {
    localDescription: null as {
      type: string;
      sdp: string;
    } | null,
    remoteDescription: null as {
      type: string;
      sdp: string;
    } | null,
    connectionState: "new",
    onicecandidate: null as Function | null,
    onconnectionstatechange: null as Function | null,
    ondatachannel: null as Function | null,
    createOffer: vi.fn(async () => ({
      type: "offer",
      sdp: "mock-offer-sdp",
    })),
    createAnswer: vi.fn(async () => ({
      type: "answer",
      sdp: "mock-answer-sdp",
    })),
    setLocalDescription: vi.fn(async (desc: unknown) => {
      pc.localDescription = desc as typeof pc.localDescription;
    }),
    setRemoteDescription: vi.fn(async (desc: unknown) => {
      pc.remoteDescription = desc as typeof pc.remoteDescription;
    }),
    addIceCandidate: vi.fn(async () => {}),
    createDataChannel: vi.fn(() => ({
      label: "test",
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    simulateConnected() {
      pc.connectionState = "connected";
      if (pc.onconnectionstatechange) {
        (pc.onconnectionstatechange as Function)();
      }
    },
    simulateFailed() {
      pc.connectionState = "failed";
      if (pc.onconnectionstatechange) {
        (pc.onconnectionstatechange as Function)();
      }
    },
    simulateDisconnected() {
      pc.connectionState = "disconnected";
      if (pc.onconnectionstatechange) {
        (pc.onconnectionstatechange as Function)();
      }
    },
    simulateIceCandidate(candidate: unknown) {
      if (pc.onicecandidate) {
        (pc.onicecandidate as Function)({
          candidate,
        });
      }
    },
  };
  return pc;
}

/* eslint-enable @typescript-eslint/no-unsafe-function-type */

type MockPC = ReturnType<typeof createMockPC>;

// -------------------------------------------------------
// PeerManager tests
// -------------------------------------------------------

describe("PeerManager", () => {
  type TimerOverrides = {
    createTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
    jitter?: () => number;
  };

  function setup(localPeerId = "aaa-local", overrides: TimerOverrides = {}) {
    const { client, ...fires } = createMockSignalingClient();
    const pcs: MockPC[] = [];

    const manager = createPeerManager(client, "room1", localPeerId, {
      createPC: () => {
        const pc = createMockPC();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      ...overrides,
    });

    return { client, manager, pcs, ...fires };
  }

  it("initiator creates offer when peer joins", async () => {
    const { client, manager, pcs, firePeerJoined } = setup("aaa-local");

    // "zzz-remote" > "aaa-local" → local is
    // initiator
    firePeerJoined("room1", "zzz-remote");
    await tick();

    expect(pcs).toHaveLength(1);
    expect(pcs[0]!.createOffer).toHaveBeenCalled();
    expect(pcs[0]!.setLocalDescription).toHaveBeenCalled();

    // Should have sent an SDP offer signal
    expect(client.sendSignal).toHaveBeenCalled();
    const call = (client.sendSignal as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("room1");
    expect(call[1]).toBe("zzz-remote");
    const decoded = decodeWebRTCSignal(call[2]);
    expect(decoded.type).toBe(WebRTCSignalType.SDP_OFFER);

    manager.destroy();
  });

  it("responder does not create offer", async () => {
    const { client, manager, pcs, firePeerJoined } = setup("zzz-local");

    // "aaa-remote" < "zzz-local" → local is
    // NOT initiator
    firePeerJoined("room1", "aaa-remote");
    await tick();

    // PC is created (to receive offer) but
    // no offer sent
    expect(pcs).toHaveLength(1);
    expect(client.sendSignal).not.toHaveBeenCalled();

    manager.destroy();
  });

  it("onPeerCreated fires before SDP offer", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    const created: {
      pc: unknown;
      initiator: boolean;
    }[] = [];
    manager.onPeerCreated((pc, initiator) => {
      created.push({ pc, initiator });
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Callback fires at creation (before offer)
    expect(created).toHaveLength(1);
    expect(created[0]!.initiator).toBe(true);
    expect(created[0]!.pc).toBe(pcs[0]);

    manager.destroy();
  });

  it("handles incoming SDP answer", async () => {
    const { manager, pcs, firePeerJoined, fireSignal } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_ANSWER,
        sdp: {
          type: "answer",
          sdp: "remote-answer",
        },
      }),
    );
    await tick();

    expect(pcs[0]!.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "remote-answer",
    });

    manager.destroy();
  });

  it("responder handles incoming SDP offer " + "and sends answer", async () => {
    const { client, manager, pcs, firePeerJoined, fireSignal } =
      setup("zzz-local");

    // Responder: remote peer joined, no offer
    // sent yet
    firePeerJoined("room1", "aaa-remote");
    await tick();

    // Now receive SDP offer from initiator
    fireSignal(
      "room1",
      "aaa-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_OFFER,
        sdp: {
          type: "offer",
          sdp: "remote-offer",
        },
      }),
    );
    await tick();

    expect(pcs[0]!.setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "remote-offer",
    });
    expect(pcs[0]!.createAnswer).toHaveBeenCalled();
    expect(pcs[0]!.setLocalDescription).toHaveBeenCalled();

    // Should have sent answer back
    expect(client.sendSignal).toHaveBeenCalled();
    const call = (client.sendSignal as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const decoded = decodeWebRTCSignal(call[2]);
    expect(decoded.type).toBe(WebRTCSignalType.SDP_ANSWER);

    manager.destroy();
  });

  it("handles incoming ICE candidate", async () => {
    const { manager, pcs, firePeerJoined, fireSignal } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Send SDP answer so remote description is set
    // (ICE candidates are buffered until then)
    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_ANSWER,
        sdp: { type: "answer", sdp: "mock-answer" },
      }),
    );
    await tick();

    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.ICE_CANDIDATE,
        candidate: {
          candidate: "candidate:...",
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      }),
    );
    await tick();

    expect(pcs[0]!.addIceCandidate).toHaveBeenCalled();

    manager.destroy();
  });

  it("buffers ICE candidates until remote description set", async () => {
    const { manager, pcs, firePeerJoined, fireSignal } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Send ICE candidate BEFORE SDP answer
    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.ICE_CANDIDATE,
        candidate: {
          candidate: "early-candidate",
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      }),
    );
    await tick();

    // Should NOT have called addIceCandidate yet
    expect(pcs[0]!.addIceCandidate).not.toHaveBeenCalled();

    // Now send SDP answer → triggers flush
    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_ANSWER,
        sdp: { type: "answer", sdp: "mock-answer" },
      }),
    );
    await tick();

    // Now the buffered candidate should be flushed
    expect(pcs[0]!.addIceCandidate).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  it("sends ICE candidates to remote peer", async () => {
    const { client, manager, pcs, firePeerJoined } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Clear the SDP offer call
    (client.sendSignal as ReturnType<typeof vi.fn>).mockClear();

    // Simulate ICE candidate from local PC
    pcs[0]!.simulateIceCandidate({
      candidate: "local-candidate",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });

    expect(client.sendSignal).toHaveBeenCalled();
    const call = (client.sendSignal as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const decoded = decodeWebRTCSignal(call[2]);
    expect(decoded.type).toBe(WebRTCSignalType.ICE_CANDIDATE);

    manager.destroy();
  });

  it("ignores signals for other rooms", async () => {
    const { manager, pcs, fireSignal } = setup("aaa-local");

    fireSignal(
      "other-room",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_OFFER,
        sdp: {
          type: "offer",
          sdp: "should-ignore",
        },
      }),
    );
    await tick();

    expect(pcs).toHaveLength(0);

    manager.destroy();
  });

  it("peer left closes connection and fires disconnCbs", async () => {
    const { manager, pcs, firePeerJoined, firePeerLeft } = setup("aaa-local");

    const disconnected: string[] = [];
    manager.onPeerDisconnected((peerId) => {
      disconnected.push(peerId);
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    firePeerLeft("room1", "zzz-remote");

    expect(pcs[0]!.close).toHaveBeenCalled();
    // PEER_LEFT is terminal; disconnCbs must fire even
    // though no retry happened.
    expect(disconnected).toEqual(["zzz-remote"]);

    manager.destroy();
  });

  it("destroy closes all connections", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    manager.destroy();

    expect(pcs[0]!.close).toHaveBeenCalled();
  });

  it("ignores self PEER_JOINED", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    // Self-join echoed back via relay forwarding
    firePeerJoined("room1", "aaa-local");
    await tick();

    // No PC should be created for self
    expect(pcs).toHaveLength(0);

    manager.destroy();
  });

  it("ignores duplicate PEER_JOINED for " + "same peer", async () => {
    const { client, manager, pcs, firePeerJoined } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // First join creates PC and sends offer
    expect(pcs).toHaveLength(1);
    expect(client.sendSignal).toHaveBeenCalledTimes(1);

    // Duplicate PEER_JOINED (e.g. from relay
    // forwarding) should be ignored
    firePeerJoined("room1", "zzz-remote");
    await tick();

    // No second PC created, no second offer
    expect(pcs).toHaveLength(1);
    expect(client.sendSignal).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  it(
    "replaces stale PC on PEER_JOINED " + "when connectionState is failed",
    async () => {
      const { client, manager, pcs, firePeerJoined } = setup("aaa-local");

      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(1);

      // Simulate connection failure — removes
      // stale entry from peers map
      pcs[0]!.simulateFailed();

      // Clear previous calls
      (client.sendSignal as ReturnType<typeof vi.fn>).mockClear();

      // Peer reconnects — should create a fresh
      // PC and send a new offer
      firePeerJoined("room1", "zzz-remote");
      await tick();

      expect(pcs).toHaveLength(2);
      expect(client.sendSignal).toHaveBeenCalled();

      manager.destroy();
    },
  );

  it(
    "replaces stale PC on PEER_JOINED " +
      "when connectionState is disconnected",
    async () => {
      const { manager, pcs, firePeerJoined } = setup("aaa-local");

      firePeerJoined("room1", "zzz-remote");
      await tick();

      // Simulate disconnection — removes stale
      // entry from peers map
      pcs[0]!.simulateDisconnected();

      // Peer reconnects — should create a new PC
      firePeerJoined("room1", "zzz-remote");
      await tick();

      expect(pcs).toHaveLength(2);

      manager.destroy();
    },
  );

  it(
    "replaces stale PC via closePC when " +
      "PEER_JOINED arrives before state change",
    async () => {
      const { manager, pcs, firePeerJoined } = setup("aaa-local");

      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(1);

      // Manually set connectionState without firing
      // the handler — simulates race where the
      // PEER_JOINED arrives before the async
      // onconnectionstatechange callback fires.

      (pcs[0] as any).connectionState = "failed";

      firePeerJoined("room1", "zzz-remote");
      await tick();

      // Old PC should be explicitly closed
      expect(pcs[0]!.close).toHaveBeenCalled();
      expect(pcs).toHaveLength(2);

      manager.destroy();
    },
  );

  it("fires onPeerConnection on connected", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    const connected: { initiator: boolean }[] = [];
    manager.onPeerConnection((_pc, initiator) => {
      connected.push({ initiator });
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    expect(connected).toHaveLength(0);

    pcs[0]!.simulateConnected();

    expect(connected).toHaveLength(1);
    expect(connected[0]!.initiator).toBe(true);

    manager.destroy();
  });

  it("does not fire onPeerDisconnected on a single failed state", async () => {
    // New semantics (B): disconnCbs are terminal-only.
    // A single "failed" transition schedules a retry,
    // it does NOT report the peer as disconnected.
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    const disconnected: string[] = [];
    manager.onPeerDisconnected((peerId) => {
      disconnected.push(peerId);
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    pcs[0]!.simulateFailed();

    // Retry is scheduled (1s backoff) but no terminal
    // disconnCbs firing.
    expect(disconnected).toEqual([]);

    manager.destroy();
  });

  it(
    "keeps PC in map during disconnected grace; " +
      "PEER_JOINED resets to fresh PC",
    async () => {
      const timers = createFakeTimers();
      const { manager, pcs, firePeerJoined } = setup("aaa-local", {
        createTimer: timers.create,
        clearTimer: timers.clear,
        jitter: () => 0.5,
      });

      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(1);

      // "disconnected" starts grace period; PC stays in
      // map (no retry yet, no eviction).
      pcs[0]!.simulateDisconnected();

      // PEER_JOINED during grace: treat as reset
      // signal — tear down stale PC, start fresh.
      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(2);

      manager.destroy();
    },
  );

  it(
    "old PC state change does not delete new PC " + "from peers map",
    async () => {
      const { manager, firePeerJoined, pcs } = setup("aaa-local");

      // First connection
      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(1);
      const oldPC = pcs[0]!;

      // Replace with new PC (stale via closePC)
      oldPC.connectionState = "failed";
      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(2);
      const newPC = pcs[1]!;

      // Old PC fires deferred state change AFTER
      // new PC is already in the map. Should NOT
      // delete the new entry.
      oldPC.connectionState = "disconnected";
      oldPC.onconnectionstatechange!({} as Event);
      await tick();

      // New PC should still be connectable
      newPC.connectionState = "connected";
      newPC.onconnectionstatechange!({} as Event);

      const connected = vi.fn();
      manager.onPeerConnection(connected);

      // Re-fire to check callback sees the new PC
      newPC.onconnectionstatechange!({} as Event);
      expect(connected).toHaveBeenCalledWith(newPC, true);

      manager.destroy();
    },
  );

  // -----------------------------------------------------
  // Retry / grace / offer-timeout
  // -----------------------------------------------------

  it("disconnected → connected cancels grace retry", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(1);

    pcs[0]!.simulateDisconnected();
    // A grace timer should be pending (plus the offer
    // timer started by sendOffer).
    expect(timers.count).toBeGreaterThanOrEqual(1);

    // Self-heal before grace expires.
    pcs[0]!.simulateConnected();

    // Connected clears all timers and resets attempts.
    expect(timers.count).toBe(0);

    // Advancing past the grace window must not trigger
    // a retry — no extra PC created.
    timers.advance(60_000);
    await tick();
    expect(pcs).toHaveLength(1);

    manager.destroy();
  });

  it("disconnected → 10s grace expiry schedules retry", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    pcs[0]!.simulateDisconnected();

    // Advance just under the grace threshold — still
    // one PC, no retry yet.
    timers.advance(9_999);
    expect(pcs).toHaveLength(1);

    // Tip into retry: grace expires → handleFailure
    // schedules retry with 1s backoff (attempt 0).
    timers.advance(1);
    expect(pcs).toHaveLength(1);

    // Backoff fires, retry creates a fresh PC.
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("failed → immediate retry (no grace)", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    pcs[0]!.simulateFailed();

    // No grace; retry is scheduled with 1s backoff
    // straight from handleFailure.
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("failed after grace is idempotent (single retry)", async () => {
    // "disconnected" starts grace. If "failed" arrives
    // before grace expires, handleFailure should
    // cancel the grace timer but not double-schedule
    // a retry: the scheduled backoff already stands.
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    pcs[0]!.simulateDisconnected();
    // Advance past grace → retry scheduled.
    timers.advance(10_000);
    // Now a late "failed" arrives.
    pcs[0]!.simulateFailed();

    // Backoff fires → single retry, not two.
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("offer timeout triggers retry", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(1);

    // No answer arrives — offer timeout (10s) +
    // first-attempt backoff (1s) → new PC.
    timers.advance(10_000);
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("SDP_ANSWER clears offer timeout", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined, fireSignal } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // One offer timer pending.
    expect(timers.count).toBe(1);

    fireSignal(
      "room1",
      "zzz-remote",
      encodeWebRTCSignal({
        type: WebRTCSignalType.SDP_ANSWER,
        sdp: { type: "answer", sdp: "ok" },
      }),
    );
    await tick();

    // Offer timer cleared.
    expect(timers.count).toBe(0);

    // Advancing past the old timeout should not retry.
    timers.advance(60_000);
    await tick();
    expect(pcs).toHaveLength(1);

    manager.destroy();
  });

  it("connected resets attempt counter", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // First failure → attempt 1 (1s backoff).
    pcs[0]!.simulateFailed();
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);

    // Second PC comes up OK → counter resets.
    pcs[1]!.simulateConnected();

    // New failure on the second PC: would be attempt 3
    // if counter didn't reset, but with reset it's
    // attempt 1 again (1s backoff, not 4s).
    pcs[1]!.simulateFailed();
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(3);

    manager.destroy();
  });

  it("retry exhaustion fires onPeerDisconnected terminally", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    const disconnected: string[] = [];
    manager.onPeerDisconnected((peerId) => {
      disconnected.push(peerId);
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Attempt 1: fail + 1s backoff.
    pcs[0]!.simulateFailed();
    timers.advance(1_000);
    await tick();
    expect(pcs).toHaveLength(2);
    expect(disconnected).toEqual([]);

    // Attempt 2: fail + 2s backoff.
    pcs[1]!.simulateFailed();
    timers.advance(2_000);
    await tick();
    expect(pcs).toHaveLength(3);
    expect(disconnected).toEqual([]);

    // Attempt 3: fail + 4s backoff.
    pcs[2]!.simulateFailed();
    timers.advance(4_000);
    await tick();
    expect(pcs).toHaveLength(4);
    expect(disconnected).toEqual([]);

    // 4th failure: attempts (3) >= MAX_RETRIES (3) →
    // exhaustion, fire disconnCbs.
    pcs[3]!.simulateFailed();
    expect(disconnected).toEqual(["zzz-remote"]);

    manager.destroy();
  });

  it("PEER_JOINED during grace resets to fresh PC", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    pcs[0]!.simulateDisconnected();

    // Partway through grace, peer re-announces.
    timers.advance(5_000);
    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(2);

    // Advance past the ORIGINAL grace deadline
    // (absolute t=10_000; we're already at 5_000 so
    // add 6_000) without reaching the fresh PC's
    // offer timeout at absolute t=15_000.
    timers.advance(6_000);
    await tick();
    // No stale grace-driven retry, still two PCs.
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("PEER_JOINED during retry backoff cancels pending retry", async () => {
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    // Drive into the retry backoff window: failure
    // schedules a retry at t=1_000 (1s backoff).
    pcs[0]!.simulateFailed();

    // Peer rejoins before the backoff fires. The
    // PEER_JOINED handler sees PC1 in map (state
    // "failed") and runs closePC, which clears the
    // pending retryTimer.
    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(2);

    // Advance past the cancelled retry deadline
    // (absolute t=1_000) but before the fresh PC's
    // offer timeout (~10s). No third PC should
    // appear — the retry was cancelled.
    timers.advance(2_000);
    await tick();
    expect(pcs).toHaveLength(2);

    manager.destroy();
  });

  it("PEER_JOINED during healthy negotiation is ignored", async () => {
    const timers = createFakeTimers();
    const { client, manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(1);
    expect(client.sendSignal).toHaveBeenCalledTimes(1);

    // Initiator mid-negotiation: connectionState is
    // "new" (healthy). Duplicate PEER_JOINED must
    // dedup.
    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(pcs).toHaveLength(1);
    expect(client.sendSignal).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  it("retry after initial offer calls createdCbs again", async () => {
    // Consumers of onPeerCreated (e.g. data-channel
    // setup) must be re-invoked on each retry because
    // the old PC's data channels die with it.
    const timers = createFakeTimers();
    const { manager, pcs, firePeerJoined } = setup("aaa-local", {
      createTimer: timers.create,
      clearTimer: timers.clear,
      jitter: () => 0.5,
    });

    const created: RTCPeerConnection[] = [];
    manager.onPeerCreated((pc) => {
      created.push(pc);
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();
    expect(created).toHaveLength(1);

    pcs[0]!.simulateFailed();
    timers.advance(1_000);
    await tick();

    expect(pcs).toHaveLength(2);
    expect(created).toHaveLength(2);
    expect(created[1]).toBe(pcs[1]);

    manager.destroy();
  });
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

/**
 * Deterministic timer harness. Matches the
 * `createTimer`/`clearTimer` signatures accepted by
 * PeerManager so retry timing can be tested without
 * real clocks.
 */
interface FakeTimers {
  create: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
  advance: (ms: number) => void;
  readonly count: number;
}

function createFakeTimers(): FakeTimers {
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    create(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(handle) {
      timers.delete(handle as unknown as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        // Scan for the soonest-due timer in range.
        let dueId = -1;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === -1) break;
        const t = timers.get(dueId);
        if (!t) break;
        timers.delete(dueId);
        now = t.at;
        t.cb();
      }
      now = target;
    },
    get count() {
      return timers.size;
    },
  };
}
