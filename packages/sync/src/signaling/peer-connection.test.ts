import { describe, it, expect, vi } from "vitest";
import {
  createPeerManager,
  encodeWebRTCSignal,
  decodeWebRTCSignal,
  WebRTCSignalType,
} from "./peer-connection.js";
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

  it("onPeerConnection fires when connected", async () => {
    const { manager, pcs, firePeerJoined } = setup("aaa-local");

    const connections: {
      pc: unknown;
      initiator: boolean;
    }[] = [];
    manager.onPeerConnection((pc, initiator) => {
      connections.push({ pc, initiator });
    });

    firePeerJoined("room1", "zzz-remote");
    await tick();

    pcs[0]!.simulateConnected();

    expect(connections).toHaveLength(1);
    expect(connections[0]!.initiator).toBe(true);
    expect(connections[0]!.pc).toBe(pcs[0]);

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
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}
