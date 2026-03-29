/**
 * Browser-side signaling client for
 * /pokapali/signaling/1.0.0.
 *
 * Opens a length-prefixed framed stream to a relay
 * node and provides callbacks for peer join/leave
 * and WebRTC signaling message exchange.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import { SignalType, encodeSignal, decodeSignal } from "./protocol.js";

const log = createLogger("signaling-client");

// -------------------------------------------------------
// Stream interface
// -------------------------------------------------------

/**
 * Minimal subset of a libp2p Stream needed by the
 * client. Avoids importing the full libp2p types.
 */
export interface SignalingStream {
  source: AsyncIterable<{
    subarray(): Uint8Array;
  }>;
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>;
  close(): void | Promise<void>;
}

// -------------------------------------------------------
// Callback types
// -------------------------------------------------------

type PeerJoinedCb = (room: string, peerId: string) => void;

type PeerLeftCb = (room: string, peerId: string) => void;

type SignalCb = (room: string, fromPeerId: string, payload: Uint8Array) => void;

type CloseCb = () => void;

// -------------------------------------------------------
// SignalingClient
// -------------------------------------------------------

export interface SignalingClient {
  joinRoom(room: string): void;
  leaveRoom(room: string): void;
  sendSignal(room: string, targetPeerId: string, payload: Uint8Array): void;
  onPeerJoined(cb: PeerJoinedCb): () => void;
  onPeerLeft(cb: PeerLeftCb): () => void;
  onSignal(cb: SignalCb): () => void;
  onClose(cb: CloseCb): () => void;
  destroy(): void;
}

/**
 * Create a signaling client that communicates with
 * a relay over the given stream.
 */
export function createSignalingClient(
  stream: SignalingStream,
): SignalingClient {
  const joinedRooms = new Set<string>();
  const peerJoinedCbs = new Set<PeerJoinedCb>();
  const peerLeftCbs = new Set<PeerLeftCb>();
  const signalCbs = new Set<SignalCb>();
  const closeCbs = new Set<CloseCb>();

  const outQueue: Uint8Array[] = [];
  let outResolve: (() => void) | null = null;
  let closed = false;

  // Outbound message queue → stream sink
  async function* outbound(): AsyncGenerator<Uint8Array> {
    while (!closed) {
      if (outQueue.length > 0) {
        yield outQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          outResolve = resolve;
        });
      }
    }
    // Flush remaining
    while (outQueue.length > 0) {
      yield outQueue.shift()!;
    }
  }

  function enqueue(bytes: Uint8Array): void {
    if (closed) return;
    outQueue.push(frameLengthPrefix(bytes));
    if (outResolve) {
      const r = outResolve;
      outResolve = null;
      r();
    }
  }

  function send(...msgs: Parameters<typeof encodeSignal>): void {
    enqueue(encodeSignal(...msgs));
  }

  function shutdown(): void {
    closed = true;
    if (outResolve) {
      const r = outResolve;
      outResolve = null;
      r();
    }
  }

  // Start sink
  stream.sink(outbound()).catch(() => {
    /* stream closed */
  });

  // Read inbound messages
  void (async () => {
    try {
      for await (const frame of createFrameReader(stream.source)) {
        const msg = decodeSignal(frame);
        switch (msg.type) {
          case SignalType.PEER_JOINED:
            log.debug("peer joined:", msg.peerId, msg.room);
            for (const cb of peerJoinedCbs) {
              cb(msg.room, msg.peerId);
            }
            break;

          case SignalType.PEER_LEFT:
            log.debug("peer left:", msg.peerId, msg.room);
            for (const cb of peerLeftCbs) {
              cb(msg.room, msg.peerId);
            }
            break;

          case SignalType.SIGNAL: {
            // Relay rewrites targetPeerId to the
            // original sender's peerId. Expose as
            // fromPeerId for clarity.
            const fromPeerId = msg.targetPeerId;
            log.debug("signal from:", fromPeerId, msg.room);
            for (const cb of signalCbs) {
              cb(msg.room, fromPeerId, msg.payload);
            }
            break;
          }

          default:
            log.warn("unexpected message type:", msg.type);
        }
      }
    } catch (err) {
      log.debug("stream read error:", err);
    } finally {
      for (const cb of closeCbs) {
        cb();
      }
      shutdown();
    }
  })();

  return {
    joinRoom(room: string): void {
      joinedRooms.add(room);
      send({
        type: SignalType.JOIN_ROOM,
        room,
      });
    },

    leaveRoom(room: string): void {
      joinedRooms.delete(room);
      send({
        type: SignalType.LEAVE_ROOM,
        room,
      });
    },

    sendSignal(room: string, targetPeerId: string, payload: Uint8Array): void {
      send({
        type: SignalType.SIGNAL,
        room,
        targetPeerId,
        payload,
      });
    },

    onPeerJoined(cb: PeerJoinedCb): () => void {
      peerJoinedCbs.add(cb);
      return () => peerJoinedCbs.delete(cb);
    },

    onPeerLeft(cb: PeerLeftCb): () => void {
      peerLeftCbs.add(cb);
      return () => peerLeftCbs.delete(cb);
    },

    onSignal(cb: SignalCb): () => void {
      signalCbs.add(cb);
      return () => signalCbs.delete(cb);
    },

    onClose(cb: CloseCb): () => void {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },

    destroy(): void {
      for (const room of joinedRooms) {
        send({
          type: SignalType.LEAVE_ROOM,
          room,
        });
      }
      joinedRooms.clear();
      shutdown();
    },
  };
}

// -------------------------------------------------------
// Length-prefix framing
// -------------------------------------------------------

/**
 * Prefix a message with its byte length as a
 * 4-byte big-endian uint32.
 */
export function frameLengthPrefix(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + data.length);
  new DataView(frame.buffer).setUint32(0, data.length);
  frame.set(data, 4);
  return frame;
}

/**
 * Read length-prefixed frames from an async
 * iterable of chunks. Handles chunk boundaries
 * that split across frame headers or bodies.
 */
async function* createFrameReader(
  source: AsyncIterable<{
    subarray(): Uint8Array;
  }>,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);

  for await (const chunk of source) {
    const bytes = chunk.subarray();
    const next = new Uint8Array(buffer.length + bytes.length);
    next.set(buffer, 0);
    next.set(bytes, buffer.length);
    buffer = next;

    while (buffer.length >= 4) {
      const len = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (buffer.length < 4 + len) break;
      yield buffer.slice(4, 4 + len);
      buffer = buffer.slice(4 + len);
    }
  }
}
