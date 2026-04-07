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
  function setup(localPeerId = "aaa-local") {
    const { client, ...fires } = createMockSignalingClient();
    const pcs: MockPC[] = [];

    const manager = createPeerManager(client, "room1", localPeerId, {
      createPC: () => {
        const pc = createMockPC();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
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

  it("peer left closes connection", async () => {
    const { manager, pcs, firePeerJoined, firePeerLeft } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    firePeerLeft("room1", "zzz-remote");

    expect(pcs[0]!.close).toHaveBeenCalled();

    manager.destroy();
  });

  it("destroy closes all connections", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    firePeerJoined("room1", "zzz-remote");
    await tick();

    manager.destroy();

    expect(pcs[0]!.close).toHaveBeenCalled();
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

  it("fires onPeerDisconnected on failed", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    const disconnected: string[] = [];
    manager.onPeerDisconnected((peerId) => {
      disconnected.push(peerId);
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    pcs[0]!.simulateFailed();

    expect(disconnected).toEqual(["zzz-remote"]);

    manager.destroy();
  });

  it(
    "cleans up stale PC from peers map " + "on disconnected state",
    async () => {
      const { manager, pcs, firePeerJoined } = setup("aaa-local");

      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(1);

      pcs[0]!.simulateDisconnected();

      // After disconnect, a new PEER_JOINED should
      // create a fresh PC (not be deduped)
      firePeerJoined("room1", "zzz-remote");
      await tick();
      expect(pcs).toHaveLength(2);

      manager.destroy();
    },
  );
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}
