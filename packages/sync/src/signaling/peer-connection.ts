/**
 * WebRTC peer connection manager.
 *
 * Uses a SignalingClient to discover peers and
 * exchange SDP offers/answers and ICE candidates.
 * Manages RTCPeerConnection lifecycle for each
 * remote peer.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import type { SignalingClient } from "./client.js";

const log = createLogger("peer-connection");
const diagLog = createLogger("p2p-diag");

// -------------------------------------------------------
// WebRTC signal sub-protocol
// -------------------------------------------------------

/**
 * Signal types sent as SIGNAL payloads through
 * the relay. First byte is the discriminant,
 * remaining bytes are JSON-encoded data.
 */
export const WebRTCSignalType = {
  SDP_OFFER: 0,
  SDP_ANSWER: 1,
  ICE_CANDIDATE: 2,
} as const;

export type WebRTCSignalType =
  (typeof WebRTCSignalType)[keyof typeof WebRTCSignalType];

export type WebRTCSignal =
  | {
      type: typeof WebRTCSignalType.SDP_OFFER;
      sdp: { type: string; sdp: string };
    }
  | {
      type: typeof WebRTCSignalType.SDP_ANSWER;
      sdp: { type: string; sdp: string };
    }
  | {
      type: typeof WebRTCSignalType.ICE_CANDIDATE;
      candidate: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
      };
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeWebRTCSignal(signal: WebRTCSignal): Uint8Array {
  let json: string;
  switch (signal.type) {
    case WebRTCSignalType.SDP_OFFER:
    case WebRTCSignalType.SDP_ANSWER:
      json = JSON.stringify(signal.sdp);
      break;
    case WebRTCSignalType.ICE_CANDIDATE:
      json = JSON.stringify(signal.candidate);
      break;
  }
  const payload = encoder.encode(json);
  const result = new Uint8Array(1 + payload.length);
  result[0] = signal.type;
  result.set(payload, 1);
  return result;
}

export function decodeWebRTCSignal(bytes: Uint8Array): WebRTCSignal {
  const type = bytes[0] as WebRTCSignalType;
  const json = decoder.decode(bytes.subarray(1));

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(
      `Malformed WebRTC signal: invalid JSON ` +
        `(type=${type}, ${json.length} bytes)`,
    );
  }

  switch (type) {
    case WebRTCSignalType.SDP_OFFER:
      return { type, sdp: data } as WebRTCSignal;
    case WebRTCSignalType.SDP_ANSWER:
      return { type, sdp: data } as WebRTCSignal;
    case WebRTCSignalType.ICE_CANDIDATE:
      return { type, candidate: data } as WebRTCSignal;
    default:
      throw new Error(`Unknown WebRTC signal type: ${type}`);
  }
}

// -------------------------------------------------------
// PeerManager
// -------------------------------------------------------

type PeerConnectionCb = (pc: RTCPeerConnection, initiator: boolean) => void;

export interface PeerManager {
  /** Fires when the RTCPeerConnection reaches
   *  "connected" state. */
  onPeerConnection(cb: PeerConnectionCb): () => void;
  /** Fires when a new RTCPeerConnection is created
   *  but BEFORE the SDP offer. Use this to add data
   *  channels so the offer includes them. */
  onPeerCreated(cb: PeerConnectionCb): () => void;
  /** Fires when an RTCPeerConnection reaches
   *  "disconnected", "failed", or "closed" state. */
  onPeerDisconnected(cb: (peerId: string) => void): () => void;
  destroy(): void;
}

export interface PeerManagerOptions {
  rtcConfig?: RTCConfiguration;
  /** Override RTCPeerConnection constructor for
   *  testing. */
  createPC?: () => RTCPeerConnection;
}

/**
 * Create a peer connection manager that uses a
 * SignalingClient for peer discovery and SDP/ICE
 * exchange.
 *
 * Initiator role: the peer with the
 * lexicographically lower peerId creates the SDP
 * offer. This is deterministic and avoids glare
 * (simultaneous offers).
 */
export function createPeerManager(
  client: SignalingClient,
  roomName: string,
  localPeerId: string,
  options?: PeerManagerOptions,
): PeerManager {
  const peers = new Map<string, RTCPeerConnection>();
  const connCbs = new Set<PeerConnectionCb>();
  const createdCbs = new Set<PeerConnectionCb>();
  const disconnCbs = new Set<(peerId: string) => void>();
  const unsubs: Array<() => void> = [];

  // ICE candidate buffering: candidates that arrive
  // before setRemoteDescription are buffered here
  // and flushed once the remote description is set.
  const iceBuf = new Map<string, RTCIceCandidateInit[]>();
  const remoteDescSet = new Set<string>();

  function bufferOrAddCandidate(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): void {
    const pc = peers.get(peerId);
    if (!pc) return;
    if (remoteDescSet.has(peerId)) {
      void pc.addIceCandidate(candidate).catch((err) => {
        log.debug("addIceCandidate failed:", err);
      });
    } else {
      let buf = iceBuf.get(peerId);
      if (!buf) {
        buf = [];
        iceBuf.set(peerId, buf);
      }
      buf.push(candidate);
      diagLog.debug(
        "ICE candidate buffered for:",
        peerId.slice(0, 12),
        "count:",
        buf.length,
      );
    }
  }

  function flushIceCandidates(peerId: string): void {
    remoteDescSet.add(peerId);
    const buf = iceBuf.get(peerId);
    if (!buf || buf.length === 0) return;
    const pc = peers.get(peerId);
    if (!pc) return;
    diagLog.debug(
      "flushing",
      buf.length,
      "buffered ICE candidates for:",
      peerId.slice(0, 12),
    );
    for (const candidate of buf) {
      void pc.addIceCandidate(candidate).catch((err) => {
        log.debug("addIceCandidate (flush) failed:", err);
      });
    }
    iceBuf.delete(peerId);
  }

  const makePC =
    options?.createPC ?? (() => new RTCPeerConnection(options?.rtcConfig));

  function isInitiator(remotePeerId: string): boolean {
    return localPeerId < remotePeerId;
  }

  function getOrCreatePC(remotePeerId: string): RTCPeerConnection {
    let pc = peers.get(remotePeerId);
    if (pc) return pc;

    pc = makePC();
    peers.set(remotePeerId, pc);

    const initiator = isInitiator(remotePeerId);
    const tag = initiator ? "initiator" : "responder";
    const rpid = remotePeerId.slice(0, 12);

    diagLog.debug(
      "PC created:",
      rpid,
      tag,
      "iceServers:",
      JSON.stringify(pc.getConfiguration?.()?.iceServers),
    );

    // ICE candidate trickle
    pc.onicecandidate = (evt) => {
      if (!evt.candidate) {
        diagLog.debug("ICE gathering done:", rpid);
        return;
      }
      diagLog.debug(
        "ICE candidate:",
        rpid,
        evt.candidate.type,
        evt.candidate.address,
        evt.candidate.protocol,
      );
      client.sendSignal(
        roomName,
        remotePeerId,
        encodeWebRTCSignal({
          type: WebRTCSignalType.ICE_CANDIDATE,
          candidate: {
            candidate: evt.candidate.candidate,
            sdpMid: evt.candidate.sdpMid,
            sdpMLineIndex: evt.candidate.sdpMLineIndex,
          },
        }),
      );
    };

    pc.addEventListener("icecandidateerror", (evt: Event) => {
      const e = evt as RTCPeerConnectionIceErrorEvent;
      diagLog.debug("ICE error:", rpid, e.errorCode, e.errorText, e.url);
    });

    pc.oniceconnectionstatechange = () => {
      diagLog.debug("ICE state:", rpid, pc!.iceConnectionState);
    };

    pc.onicegatheringstatechange = () => {
      diagLog.debug("ICE gathering:", rpid, pc!.iceGatheringState);
    };

    pc.onsignalingstatechange = () => {
      diagLog.debug("signaling state:", rpid, pc!.signalingState);
    };

    // Connection state logging + cleanup
    pc.onconnectionstatechange = () => {
      diagLog.debug("connection state:", rpid, pc!.connectionState, tag);
      if (pc!.connectionState === "connected") {
        log.debug(
          "connected to:",
          remotePeerId,
          initiator ? "(initiator)" : "(responder)",
        );
        for (const cb of connCbs) {
          cb(pc!, initiator);
        }
      }
      if (
        pc!.connectionState === "failed" ||
        pc!.connectionState === "closed" ||
        pc!.connectionState === "disconnected"
      ) {
        peers.delete(remotePeerId);
        for (const cb of disconnCbs) {
          cb(remotePeerId);
        }
      }
    };
    return pc;
  }

  function closePC(remotePeerId: string): void {
    const pc = peers.get(remotePeerId);
    if (pc) {
      pc.close();
      peers.delete(remotePeerId);
    }
    iceBuf.delete(remotePeerId);
    remoteDescSet.delete(remotePeerId);
  }

  // Peer joined → create PC, notify listeners
  // (so they can add data channels), then (if
  // initiator) send SDP offer.
  unsubs.push(
    client.onPeerJoined((room, peerId) => {
      if (room !== roomName) return;

      // Dedup: if we already have a healthy connection
      // for this peer, ignore the duplicate
      // PEER_JOINED (can happen via relay forwarding).
      // If the existing PC is stale (failed,
      // disconnected, closed), tear it down and allow
      // a fresh connection.
      const existing = peers.get(peerId);
      if (existing) {
        const state = existing.connectionState;
        if (
          state === "failed" ||
          state === "closed" ||
          state === "disconnected"
        ) {
          diagLog.debug("replacing stale PC:", peerId.slice(0, 12), state);
          closePC(peerId);
        } else {
          diagLog.debug("PEER_JOINED dedup (ignored):", peerId.slice(0, 12));
          return;
        }
      }

      diagLog.debug(
        "PEER_JOINED:",
        peerId.slice(0, 12),
        "room:",
        room,
        "initiator:",
        isInitiator(peerId),
      );
      const pc = getOrCreatePC(peerId);
      const initiator = isInitiator(peerId);

      // Let consumers add data channels before
      // the offer is created.
      for (const cb of createdCbs) {
        cb(pc, initiator);
      }

      if (initiator) {
        // Create and send SDP offer
        void (async () => {
          try {
            diagLog.debug("creating offer for:", peerId.slice(0, 12));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            diagLog.debug("offer sent to:", peerId.slice(0, 12));
            client.sendSignal(
              roomName,
              peerId,
              encodeWebRTCSignal({
                type: WebRTCSignalType.SDP_OFFER,
                sdp: offer as {
                  type: string;
                  sdp: string;
                },
              }),
            );
          } catch (err) {
            diagLog.debug(
              "offer FAILED:",
              peerId.slice(0, 12),
              (err as Error)?.message,
            );
            log.warn("offer failed:", err);
          }
        })();
      }
    }),
  );

  // Peer left → close connection
  unsubs.push(
    client.onPeerLeft((room, peerId) => {
      if (room !== roomName) return;
      log.debug("peer left:", peerId);
      closePC(peerId);
    }),
  );

  // Signal received → handle SDP or ICE
  unsubs.push(
    client.onSignal((room, fromPeerId, payload) => {
      if (room !== roomName) return;

      const signal = decodeWebRTCSignal(payload);
      const fpid = fromPeerId.slice(0, 12);

      switch (signal.type) {
        case WebRTCSignalType.SDP_OFFER: {
          diagLog.debug("SDP offer from:", fpid);
          const pc = getOrCreatePC(fromPeerId);
          void (async () => {
            try {
              await pc.setRemoteDescription(
                signal.sdp as RTCSessionDescriptionInit,
              );
              flushIceCandidates(fromPeerId);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              diagLog.debug("SDP answer sent to:", fpid);
              client.sendSignal(
                roomName,
                fromPeerId,
                encodeWebRTCSignal({
                  type: WebRTCSignalType.SDP_ANSWER,
                  sdp: answer as {
                    type: string;
                    sdp: string;
                  },
                }),
              );
            } catch (err) {
              diagLog.debug("answer FAILED:", fpid, (err as Error)?.message);
              log.warn("answer failed:", err);
            }
          })();
          break;
        }

        case WebRTCSignalType.SDP_ANSWER: {
          diagLog.debug("SDP answer from:", fpid);
          const pc = peers.get(fromPeerId);
          if (!pc) {
            diagLog.debug("no PC for answer from:", fpid);
            return;
          }
          void pc
            .setRemoteDescription(signal.sdp as RTCSessionDescriptionInit)
            .then(() => flushIceCandidates(fromPeerId))
            .catch((err) => {
              diagLog.debug(
                "setRemoteDescription failed:",
                fpid,
                (err as Error)?.message,
              );
              log.warn("setRemoteDescription failed:", err);
            });
          break;
        }

        case WebRTCSignalType.ICE_CANDIDATE: {
          bufferOrAddCandidate(fromPeerId, signal.candidate);
          break;
        }
      }
    }),
  );

  return {
    onPeerConnection(cb: PeerConnectionCb): () => void {
      connCbs.add(cb);
      return () => connCbs.delete(cb);
    },

    onPeerCreated(cb: PeerConnectionCb): () => void {
      createdCbs.add(cb);
      return () => createdCbs.delete(cb);
    },

    onPeerDisconnected(cb: (peerId: string) => void): () => void {
      disconnCbs.add(cb);
      return () => disconnCbs.delete(cb);
    },

    destroy() {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      for (const pc of peers.values()) {
        pc.close();
      }
      peers.clear();
      connCbs.clear();
      disconnCbs.clear();
      iceBuf.clear();
      remoteDescSet.clear();
    },
  };
}
