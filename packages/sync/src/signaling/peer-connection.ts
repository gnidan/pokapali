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

type TimerHandle = ReturnType<typeof setTimeout>;

// Offer/answer timeout: initiator waits this long for
// an answer after sending the offer. If no answer, the
// connection is treated as failed.
const OFFER_TIMEOUT_MS = 10_000;

// Disconnected grace period: WebRTC may self-recover
// from a transient "disconnected" state. Wait this
// long before treating it as a retry-worthy failure.
const GRACE_MS = 10_000;

// Retry schedule: base 1s, doubled per attempt, so the
// three attempts wait 1s / 2s / 4s before firing.
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRIES = 3;

// ±30% jitter on each backoff interval — prevents
// thundering herd when many peers drop simultaneously.
const JITTER_FRACTION = 0.3;

export interface PeerManager {
  /** Fires when the RTCPeerConnection reaches
   *  "connected" state. */
  onPeerConnection(cb: PeerConnectionCb): () => void;
  /** Fires when a new RTCPeerConnection is created
   *  but BEFORE the SDP offer. Use this to add data
   *  channels so the offer includes them. Also fires
   *  on each retry attempt — consumers must re-attach
   *  any per-PC state (data channels, event handlers).
   */
  onPeerCreated(cb: PeerConnectionCb): () => void;
  /** Fires on terminal disconnect only: retry
   *  exhaustion, or explicit `onPeerLeft` teardown.
   *  Does NOT fire on transient state transitions;
   *  the retry layer absorbs those. */
  onPeerDisconnected(cb: (peerId: string) => void): () => void;
  destroy(): void;
}

export interface PeerManagerOptions {
  rtcConfig?: RTCConfiguration;
  /** Override RTCPeerConnection constructor for
   *  testing. */
  createPC?: () => RTCPeerConnection;
  /** Timer injection for deterministic retry tests.
   *  Defaults to global setTimeout/clearTimeout. */
  createTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Jitter source in [0, 1]; defaults to Math.random.
   *  Deterministic tests can inject e.g. `() => 0.5`. */
  jitter?: () => number;
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

  // Per-peer retry state: attempts counter + three
  // timers (offer timeout, disconnected grace,
  // pending retry backoff). Lives alongside `peers`
  // so we can track retries across PC recreations.
  interface PeerState {
    attempts: number;
    offerTimer: TimerHandle | null;
    disconnectedTimer: TimerHandle | null;
    retryTimer: TimerHandle | null;
  }
  const peerState = new Map<string, PeerState>();

  // setTimeout/clearTimeout are typed ambiguously
  // when both DOM and Node lib types are in scope —
  // cast via the injectable signature to pin them
  // down.
  const createTimer: (cb: () => void, ms: number) => TimerHandle =
    options?.createTimer ?? ((cb, ms) => setTimeout(cb, ms) as TimerHandle);
  const clearTimer: (handle: TimerHandle) => void =
    options?.clearTimer ??
    ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const jitter = options?.jitter ?? Math.random;

  function getOrCreatePeerState(peerId: string): PeerState {
    let ps = peerState.get(peerId);
    if (!ps) {
      ps = {
        attempts: 0,
        offerTimer: null,
        disconnectedTimer: null,
        retryTimer: null,
      };
      peerState.set(peerId, ps);
    }
    return ps;
  }

  function clearAllTimers(ps: PeerState): void {
    if (ps.offerTimer !== null) {
      clearTimer(ps.offerTimer);
      ps.offerTimer = null;
    }
    if (ps.disconnectedTimer !== null) {
      clearTimer(ps.disconnectedTimer);
      ps.disconnectedTimer = null;
    }
    if (ps.retryTimer !== null) {
      clearTimer(ps.retryTimer);
      ps.retryTimer = null;
    }
  }

  // 1s, 2s, 4s... with ±JITTER_FRACTION jitter.
  function computeBackoffMs(attempt: number): number {
    const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
    const offset = base * JITTER_FRACTION * (2 * jitter() - 1);
    return Math.max(0, Math.round(base + offset));
  }

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

    // Connection state handling with retry layer.
    //
    // Under the retry model:
    //  - "connected" → clear timers, reset attempts, fire
    //    connCbs.
    //  - "disconnected" → start 10s grace timer. Do NOT
    //    fire disconnCbs (WebRTC may self-recover).
    //  - "failed" → clear grace timer, schedule retry or
    //    exhaust. Do NOT fire disconnCbs during retry
    //    attempts.
    //  - "closed" → absorbed here; the caller that
    //    issued close() fires disconnCbs if the close
    //    was truly terminal.
    //
    // Stale-handler guard: this closure captures `pc`.
    // If the peers map was swapped to a new PC (e.g.
    // retry created a replacement), the old PC's
    // deferred state events must not touch the new
    // PC's state.
    pc.onconnectionstatechange = () => {
      const state = pc!.connectionState;
      diagLog.info("connection state:", rpid, state, tag);
      if (peers.get(remotePeerId) !== pc) {
        return;
      }

      if (state === "connected") {
        const ps = peerState.get(remotePeerId);
        if (ps) {
          clearAllTimers(ps);
          ps.attempts = 0;
        }
        log.debug(
          "connected to:",
          remotePeerId,
          initiator ? "(initiator)" : "(responder)",
        );
        for (const cb of connCbs) {
          cb(pc!, initiator);
        }
        return;
      }

      if (state === "disconnected") {
        const ps = getOrCreatePeerState(remotePeerId);
        if (ps.disconnectedTimer !== null) return;
        diagLog.info("grace timer started:", rpid);
        ps.disconnectedTimer = createTimer(() => {
          ps.disconnectedTimer = null;
          if (peers.get(remotePeerId) !== pc) return;
          diagLog.info("grace expired; upgrading to retry:", rpid);
          handleFailure(remotePeerId, pc!);
        }, GRACE_MS);
        return;
      }

      if (state === "failed") {
        handleFailure(remotePeerId, pc!);
        return;
      }

      // "closed" / "new" / "connecting": nothing to do
      // in the handler; transient or caller-driven.
    };
    return pc;
  }

  /**
   * Escalate a peer into the retry path. Called from:
   *  - "failed" state transitions
   *  - grace-timer expiry (still disconnected after 10s)
   *  - offer-answer timeout (no answer received)
   *
   * Pre: `failedPC` is the currently-tracked PC for
   * `peerId`. If it's been replaced, caller should
   * have guarded already.
   */
  function handleFailure(peerId: string, failedPC: RTCPeerConnection): void {
    const ps = getOrCreatePeerState(peerId);

    // Idempotent: if a retry is already scheduled,
    // don't double-schedule (e.g. "disconnected"
    // followed by "failed" in quick succession).
    if (ps.retryTimer !== null) return;

    // Clear offer/grace timers — the failure supersedes
    // both.
    if (ps.offerTimer !== null) {
      clearTimer(ps.offerTimer);
      ps.offerTimer = null;
    }
    if (ps.disconnectedTimer !== null) {
      clearTimer(ps.disconnectedTimer);
      ps.disconnectedTimer = null;
    }

    if (ps.attempts >= MAX_RETRIES) {
      // Exhausted. Close PC, fire disconnCbs terminally,
      // clean up state. Future PEER_JOINED for this
      // peerId starts a fresh attempt.
      diagLog.info(
        "peer-retry-exhausted:",
        peerId.slice(0, 12),
        "attempts:",
        ps.attempts,
      );
      log.warn("retry exhausted for peer:", peerId);
      closePC(peerId);
      for (const cb of disconnCbs) cb(peerId);
      return;
    }

    const delay = computeBackoffMs(ps.attempts);
    ps.attempts++;
    diagLog.info(
      "scheduling retry:",
      peerId.slice(0, 12),
      "attempt:",
      ps.attempts,
      "delay-ms:",
      delay,
    );
    ps.retryTimer = createTimer(() => {
      ps.retryTimer = null;
      executeRetry(peerId, failedPC);
    }, delay);
  }

  /**
   * Tear down the old PC and create a fresh one. If we
   * are initiator, fire off a new SDP offer. Responder
   * side creates a fresh PC and waits for the
   * initiator's new offer (symmetric retry — both sides
   * detect the failure and prepare).
   */
  function executeRetry(peerId: string, oldPC: RTCPeerConnection): void {
    if (peers.get(peerId) === oldPC) {
      peers.delete(peerId);
      iceBuf.delete(peerId);
      remoteDescSet.delete(peerId);
      try {
        oldPC.close();
      } catch (err) {
        diagLog.debug("oldPC.close error:", (err as Error)?.message);
      }
    }
    diagLog.info("retry: creating fresh PC for:", peerId.slice(0, 12));
    const pc = getOrCreatePC(peerId);
    const initiator = isInitiator(peerId);
    for (const cb of createdCbs) cb(pc, initiator);
    if (initiator) {
      void sendOffer(pc, peerId);
    }
  }

  /**
   * Issue an SDP offer to `peerId`. Starts the offer
   * timeout timer after setLocalDescription; the timer
   * is cleared when the answer's setRemoteDescription
   * is applied.
   */
  async function sendOffer(
    pc: RTCPeerConnection,
    peerId: string,
  ): Promise<void> {
    const short = peerId.slice(0, 12);
    try {
      diagLog.debug("creating offer for:", short);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (peers.get(peerId) !== pc) return;

      // Start the offer-answer timeout now (after
      // setLocalDescription). Cleared on answer.
      const ps = getOrCreatePeerState(peerId);
      if (ps.offerTimer !== null) clearTimer(ps.offerTimer);
      ps.offerTimer = createTimer(() => {
        ps.offerTimer = null;
        if (peers.get(peerId) !== pc) return;
        diagLog.info("offer timeout:", short);
        handleFailure(peerId, pc);
      }, OFFER_TIMEOUT_MS);

      diagLog.debug("offer sent to:", short);
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
      diagLog.debug("offer FAILED:", short, (err as Error)?.message);
      log.warn("offer failed:", err);
    }
  }

  function closePC(remotePeerId: string): void {
    const pc = peers.get(remotePeerId);
    if (pc) {
      peers.delete(remotePeerId);
      pc.close();
    }
    iceBuf.delete(remotePeerId);
    remoteDescSet.delete(remotePeerId);
    const ps = peerState.get(remotePeerId);
    if (ps) {
      clearAllTimers(ps);
      peerState.delete(remotePeerId);
    }
  }

  // Peer joined → create PC, notify listeners
  // (so they can add data channels), then (if
  // initiator) send SDP offer.
  unsubs.push(
    client.onPeerJoined((room, peerId) => {
      if (room !== roomName) return;

      // Ignore self-joins — happens when this browser
      // is connected to multiple relays and relay
      // forwarding echoes our own peerId back.
      if (peerId === localPeerId) {
        diagLog.debug("PEER_JOINED self (ignored):", peerId.slice(0, 12));
        return;
      }

      // Dedup vs. reset. Three cases:
      //   (1) PC exists and is healthy
      //       ("new"/"connecting"/"connected") —
      //       relay duplicate; ignore.
      //   (2) PC exists but is stale (disconnected /
      //       failed / closed) — tear down old state
      //       and start fresh discovery.
      //   (3) No PC but retry state is pending (mid
      //       backoff) — cancel retry, start fresh.
      const existing = peers.get(peerId);
      const hasRetryState = peerState.has(peerId);
      if (existing) {
        const state = existing.connectionState;
        if (
          state === "new" ||
          state === "connecting" ||
          state === "connected"
        ) {
          diagLog.debug("PEER_JOINED dedup (healthy):", peerId.slice(0, 12));
          return;
        }
        diagLog.debug(
          "PEER_JOINED replacing stale PC:",
          peerId.slice(0, 12),
          state,
        );
        closePC(peerId);
      } else if (hasRetryState) {
        // Retry backoff in progress with no active PC.
        // Cancel and start fresh.
        diagLog.debug(
          "PEER_JOINED cancelling retry state:",
          peerId.slice(0, 12),
        );
        const ps = peerState.get(peerId)!;
        clearAllTimers(ps);
        peerState.delete(peerId);
      }

      diagLog.info(
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
        void sendOffer(pc, peerId);
      }
    }),
  );

  // Peer left → close connection + fire terminal
  // disconnCbs. PEER_LEFT is a semantic signal that
  // the peer is gone; no retry is warranted.
  unsubs.push(
    client.onPeerLeft((room, peerId) => {
      if (room !== roomName) return;
      log.debug("peer left:", peerId);
      const hadAnyState = peers.has(peerId) || peerState.has(peerId);
      closePC(peerId);
      if (hadAnyState) {
        for (const cb of disconnCbs) cb(peerId);
      }
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
          // Answer received — clear the offer-answer
          // timeout. Done before setRemoteDescription
          // resolves so the timeout can't fire during
          // the async description apply.
          const ps = peerState.get(fromPeerId);
          if (ps?.offerTimer !== undefined && ps?.offerTimer !== null) {
            clearTimer(ps.offerTimer);
            ps.offerTimer = null;
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
      for (const ps of peerState.values()) clearAllTimers(ps);
      peerState.clear();
      for (const pc of peers.values()) {
        pc.close();
      }
      peers.clear();
      connCbs.clear();
      createdCbs.clear();
      disconnCbs.clear();
      iceBuf.clear();
      remoteDescSet.clear();
    },
  };
}
