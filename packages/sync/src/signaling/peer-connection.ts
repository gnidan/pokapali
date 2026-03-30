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
      console.log(
        "[P2P-DIAG] ICE candidate buffered for:",
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
    console.log(
      "[P2P-DIAG] flushing",
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

    console.log(
      "[P2P-DIAG] PC created:",
      rpid,
      tag,
      "iceServers:",
      JSON.stringify(pc.getConfiguration?.()?.iceServers),
    );

    // ICE candidate trickle
    pc.onicecandidate = (evt) => {
      if (!evt.candidate) {
        console.log("[P2P-DIAG] ICE gathering done:", rpid);
        return;
      }
      console.log(
        "[P2P-DIAG] ICE candidate:",
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
      console.log(
        "[P2P-DIAG] ICE error:",
        rpid,
        e.errorCode,
        e.errorText,
        e.url,
      );
    });

    pc.oniceconnectionstatechange = () => {
      console.log("[P2P-DIAG] ICE state:", rpid, pc!.iceConnectionState);
    };

    pc.onicegatheringstatechange = () => {
      console.log("[P2P-DIAG] ICE gathering:", rpid, pc!.iceGatheringState);
    };

    pc.onsignalingstatechange = () => {
      console.log("[P2P-DIAG] signaling state:", rpid, pc!.signalingState);
    };

    // Connection state → notify listeners
    pc.onconnectionstatechange = () => {
      console.log(
        "[P2P-DIAG] connection state:",
        rpid,
        pc!.connectionState,
        tag,
      );
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
    iceBuf.delete(remotePeerId);
    remoteDescSet.delete(remotePeerId);
  }

  // Peer joined → create PC and (if initiator)
  // send SDP offer
  unsubs.push(
    client.onPeerJoined((room, peerId) => {
      if (room !== roomName) return;

      // Dedup: if we already have a connection for
      // this peer, ignore the duplicate PEER_JOINED
      // (can happen via relay forwarding).
      if (peers.has(peerId)) {
        console.log(
          "[P2P-DIAG] PEER_JOINED dedup (ignored):",
          peerId.slice(0, 12),
        );
        return;
      }

      console.log(
        "[P2P-DIAG] PEER_JOINED:",
        peerId.slice(0, 12),
        "room:",
        room,
        "initiator:",
        isInitiator(peerId),
      );
      const pc = getOrCreatePC(peerId);

      if (isInitiator(peerId)) {
        // Create a data channel before the offer so
        // the SDP includes media lines and ICE
        // negotiation actually starts.
        pc.createDataChannel("_init");

        // Create and send SDP offer
        void (async () => {
          try {
            console.log("[P2P-DIAG] creating offer for:", peerId.slice(0, 12));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            console.log("[P2P-DIAG] offer sent to:", peerId.slice(0, 12));
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
            console.log(
              "[P2P-DIAG] offer FAILED:",
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
          console.log("[P2P-DIAG] SDP offer from:", fpid);
          const pc = getOrCreatePC(fromPeerId);
          void (async () => {
            try {
              await pc.setRemoteDescription(
                signal.sdp as RTCSessionDescriptionInit,
              );
              flushIceCandidates(fromPeerId);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              console.log("[P2P-DIAG] SDP answer sent to:", fpid);
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
              console.log(
                "[P2P-DIAG] answer FAILED:",
                fpid,
                (err as Error)?.message,
              );
              log.warn("answer failed:", err);
            }
          })();
          break;
        }

        case WebRTCSignalType.SDP_ANSWER: {
          console.log("[P2P-DIAG] SDP answer from:", fpid);
          const pc = peers.get(fromPeerId);
          if (!pc) {
            console.log("[P2P-DIAG] no PC for answer from:", fpid);
            return;
          }
          void pc
            .setRemoteDescription(signal.sdp as RTCSessionDescriptionInit)
            .then(() => flushIceCandidates(fromPeerId))
            .catch((err) => {
              console.log(
                "[P2P-DIAG] setRemoteDescription failed:",
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

    destroy() {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      for (const pc of peers.values()) {
        pc.close();
      }
      peers.clear();
      connCbs.clear();
      iceBuf.clear();
      remoteDescSet.clear();
    },
  };
}
