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
  onPeerConnection(cb: PeerConnectionCb): () => void;
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
  const unsubs: Array<() => void> = [];

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

    // ICE candidate trickle
    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
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

    // Connection state → notify listeners
    pc.onconnectionstatechange = () => {
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
        pc!.connectionState === "closed"
      ) {
        peers.delete(remotePeerId);
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
  }

  // Peer joined → create PC and (if initiator)
  // send SDP offer
  unsubs.push(
    client.onPeerJoined((room, peerId) => {
      if (room !== roomName) return;

      log.debug("peer joined:", peerId);
      const pc = getOrCreatePC(peerId);

      if (isInitiator(peerId)) {
        // Create and send SDP offer
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
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

      switch (signal.type) {
        case WebRTCSignalType.SDP_OFFER: {
          // Responder: set remote description
          // and create answer
          const pc = getOrCreatePC(fromPeerId);
          void (async () => {
            try {
              await pc.setRemoteDescription(
                signal.sdp as RTCSessionDescriptionInit,
              );
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
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
              log.warn("answer failed:", err);
            }
          })();
          break;
        }

        case WebRTCSignalType.SDP_ANSWER: {
          const pc = peers.get(fromPeerId);
          if (!pc) return;
          void pc
            .setRemoteDescription(signal.sdp as RTCSessionDescriptionInit)
            .catch((err) => log.warn("setRemoteDescription failed:", err));
          break;
        }

        case WebRTCSignalType.ICE_CANDIDATE: {
          const pc = peers.get(fromPeerId);
          if (!pc) return;
          void pc
            .addIceCandidate(signal.candidate)
            .catch((err) => log.warn("addIceCandidate failed:", err));
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

    destroy() {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      for (const pc of peers.values()) {
        pc.close();
      }
      peers.clear();
      connCbs.clear();
    },
  };
}
