/**
 * Wire format for the /pokapali/signaling/1.0.0
 * stream protocol.
 *
 * Uses lib0 encoding/decoding for compact binary
 * format. Message type discriminant is the first
 * byte (writeVarUint).
 *
 * @module
 */

import {
  createEncoder,
  writeVarUint,
  writeVarString,
  writeVarUint8Array,
  toUint8Array,
} from "lib0/encoding";
import {
  createDecoder,
  readVarUint,
  readVarString,
  readVarUint8Array,
} from "lib0/decoding";

// -------------------------------------------------------
// Protocol identifier
// -------------------------------------------------------

export const SIGNALING_PROTOCOL = "/pokapali/signaling/1.0.0";

// -------------------------------------------------------
// Message type discriminant
// -------------------------------------------------------

export const SignalType = {
  JOIN_ROOM: 0,
  LEAVE_ROOM: 1,
  SIGNAL: 2,
  PEER_JOINED: 3,
  PEER_LEFT: 4,
} as const;

export type SignalType = (typeof SignalType)[keyof typeof SignalType];

// -------------------------------------------------------
// Message types
// -------------------------------------------------------

export interface JoinRoom {
  type: typeof SignalType.JOIN_ROOM;
  room: string;
}

export interface LeaveRoom {
  type: typeof SignalType.LEAVE_ROOM;
  room: string;
}

export interface Signal {
  type: typeof SignalType.SIGNAL;
  room: string;
  targetPeerId: string;
  payload: Uint8Array;
}

export interface PeerJoined {
  type: typeof SignalType.PEER_JOINED;
  room: string;
  peerId: string;
}

export interface PeerLeft {
  type: typeof SignalType.PEER_LEFT;
  room: string;
  peerId: string;
}

export type SignalMessage =
  | JoinRoom
  | LeaveRoom
  | Signal
  | PeerJoined
  | PeerLeft;

// -------------------------------------------------------
// Encode
// -------------------------------------------------------

export function encodeSignal(msg: SignalMessage): Uint8Array {
  const enc = createEncoder();
  writeVarUint(enc, msg.type);

  switch (msg.type) {
    case SignalType.JOIN_ROOM:
      writeVarString(enc, msg.room);
      break;

    case SignalType.LEAVE_ROOM:
      writeVarString(enc, msg.room);
      break;

    case SignalType.SIGNAL:
      writeVarString(enc, msg.room);
      writeVarString(enc, msg.targetPeerId);
      writeVarUint8Array(enc, msg.payload);
      break;

    case SignalType.PEER_JOINED:
      writeVarString(enc, msg.room);
      writeVarString(enc, msg.peerId);
      break;

    case SignalType.PEER_LEFT:
      writeVarString(enc, msg.room);
      writeVarString(enc, msg.peerId);
      break;
  }

  return toUint8Array(enc);
}

// -------------------------------------------------------
// Decode
// -------------------------------------------------------

export function decodeSignal(bytes: Uint8Array): SignalMessage {
  const dec = createDecoder(bytes);
  const type = readVarUint(dec) as SignalType;

  switch (type) {
    case SignalType.JOIN_ROOM:
      return { type, room: readVarString(dec) };

    case SignalType.LEAVE_ROOM:
      return { type, room: readVarString(dec) };

    case SignalType.SIGNAL:
      return {
        type,
        room: readVarString(dec),
        targetPeerId: readVarString(dec),
        payload: readVarUint8Array(dec),
      };

    case SignalType.PEER_JOINED:
      return {
        type,
        room: readVarString(dec),
        peerId: readVarString(dec),
      };

    case SignalType.PEER_LEFT:
      return {
        type,
        room: readVarString(dec),
        peerId: readVarString(dec),
      };

    default:
      throw new Error(`Unknown signal type: ${type}`);
  }
}
