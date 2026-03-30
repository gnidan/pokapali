/**
 * Relay-side stream handler for
 * /pokapali/signaling/1.0.0.
 *
 * Reads framed messages from an incoming libp2p
 * stream and routes JOIN_ROOM, LEAVE_ROOM, and
 * SIGNAL messages through the room registry.
 *
 * @module
 */

import { createLogger } from "@pokapali/log";
import {
  SignalType,
  encodeSignal,
  decodeSignal,
  type SignalMessage,
} from "./protocol.js";
import type { RoomRegistry } from "./registry.js";
import type { RelayForwarder } from "./relay-forward.js";

const log = createLogger("signaling");

/**
 * Minimal subset of a libp2p Stream needed by the
 * handler. Avoids importing the full libp2p
 * interface types.
 */
export interface SignalingStream {
  source: AsyncIterable<{ subarray(): Uint8Array }>;
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>;
  close(): void | Promise<void>;
}

export interface HandlerOptions {
  registry: RoomRegistry;
  /** If provided, the handler broadcasts join/leave
   *  events to other relays via GossipSub. */
  forwarder?: RelayForwarder;
}

/**
 * Handle an incoming signaling stream from a browser
 * peer. Reads messages, routes through the registry,
 * and cleans up on close.
 */
export function handleSignalingStream(
  peerId: string,
  stream: SignalingStream,
  options: HandlerOptions,
): void {
  const { registry, forwarder } = options;
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

  function sendTo(
    targetPeerId: string,
    room: string,
    msg: SignalMessage,
  ): void {
    const target = registry.findPeer(room, targetPeerId);
    if (target) {
      target.send(encodeSignal(msg));
    }
  }

  function sendToSelf(msg: SignalMessage): void {
    enqueue(encodeSignal(msg));
  }

  function enqueue(bytes: Uint8Array): void {
    outQueue.push(frameLengthPrefix(bytes));
    if (outResolve) {
      const r = outResolve;
      outResolve = null;
      r();
    }
  }

  function cleanup(): void {
    closed = true;
    if (outResolve) {
      const r = outResolve;
      outResolve = null;
      r();
    }
    const leftRooms = registry.leaveAll(peerId);
    for (const room of leftRooms) {
      log.debug("peer left (disconnect):", peerId, room);
      forwarder?.onLocalLeave(room, peerId);
      const peerLeftMsg = encodeSignal({
        type: SignalType.PEER_LEFT,
        room,
        peerId,
      });
      for (const member of registry.members(room)) {
        member.send(peerLeftMsg);
      }
    }
  }

  const entry = {
    peerId,
    send: enqueue,
  };

  // Start sink
  stream.sink(outbound()).catch(() => {
    cleanup();
  });

  // Read inbound messages
  void (async () => {
    try {
      const reader = createFrameReader(stream.source);
      for await (const frame of reader) {
        const msg = decodeSignal(frame);
        processMessage(peerId, msg, entry);
      }
    } catch (err) {
      log.debug("stream read error:", peerId, err);
    } finally {
      cleanup();
    }
  })();

  function processMessage(
    fromPeerId: string,
    msg: SignalMessage,
    senderEntry: { peerId: string; send: (bytes: Uint8Array) => void },
  ): void {
    switch (msg.type) {
      case SignalType.JOIN_ROOM: {
        log.debug("join:", fromPeerId, msg.room);
        // Notify existing members
        const existing = registry.members(msg.room);
        const joinedMsg = encodeSignal({
          type: SignalType.PEER_JOINED,
          room: msg.room,
          peerId: fromPeerId,
        });
        for (const member of existing) {
          member.send(joinedMsg);
        }
        // Notify joiner about existing members
        for (const member of existing) {
          sendToSelf({
            type: SignalType.PEER_JOINED,
            room: msg.room,
            peerId: member.peerId,
          });
        }
        // Add to registry after notifications
        registry.join(msg.room, senderEntry);
        forwarder?.onLocalJoin(msg.room, fromPeerId);
        break;
      }

      case SignalType.LEAVE_ROOM: {
        log.debug("leave:", fromPeerId, msg.room);
        registry.leave(msg.room, fromPeerId);
        forwarder?.onLocalLeave(msg.room, fromPeerId);
        const leftMsg = encodeSignal({
          type: SignalType.PEER_LEFT,
          room: msg.room,
          peerId: fromPeerId,
        });
        for (const member of registry.members(msg.room)) {
          member.send(leftMsg);
        }
        break;
      }

      case SignalType.SIGNAL: {
        log.debug("signal:", fromPeerId, "→", msg.targetPeerId, msg.room);
        sendTo(msg.targetPeerId, msg.room, {
          type: SignalType.SIGNAL,
          room: msg.room,
          targetPeerId: fromPeerId,
          payload: msg.payload,
        });
        break;
      }

      default:
        log.warn("unexpected message type from peer:", fromPeerId, msg.type);
    }
  }
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
export async function* createFrameReader(
  source: AsyncIterable<{ subarray(): Uint8Array }>,
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
