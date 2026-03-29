/**
 * Protocol message types and binary encoding for
 * edit reconciliation.
 *
 * Uses lib0 encoding/decoding for compact wire
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
// Message type discriminant
// -------------------------------------------------------

export const MessageType = {
  RECONCILE_START: 0,
  TRIE_QUERY: 1,
  TRIE_RESPONSE: 2,
  EDIT_SET: 3,
  EDIT_BATCH: 4,
  FULL_STATE: 5,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// -------------------------------------------------------
// Message types
// -------------------------------------------------------

export interface ReconcileStart {
  type: typeof MessageType.RECONCILE_START;
  channel: string;
  /** 32-byte root fingerprint. */
  fingerprint: Uint8Array;
  editCount: number;
}

export interface TrieQuery {
  type: typeof MessageType.TRIE_QUERY;
  channel: string;
  prefix: Uint8Array;
  depth: number;
  /** 32-byte fingerprint at this prefix. */
  fingerprint: Uint8Array;
  editCount: number;
}

export interface TrieResponse {
  type: typeof MessageType.TRIE_RESPONSE;
  channel: string;
  prefix: Uint8Array;
  depth: number;
  /** 32-byte fingerprint at this prefix. */
  fingerprint: Uint8Array;
  match: boolean;
}

export interface EditSet {
  type: typeof MessageType.EDIT_SET;
  channel: string;
  prefix: Uint8Array;
  depth: number;
  /** Array of 32-byte edit hashes. */
  hashes: Uint8Array[];
}

export interface EditBatch {
  type: typeof MessageType.EDIT_BATCH;
  channel: string;
  edits: Array<{
    payload: Uint8Array;
    signature: Uint8Array;
  }>;
}

export interface FullState {
  type: typeof MessageType.FULL_STATE;
  channel: string;
  snapshot: Uint8Array;
}

export type Message =
  | ReconcileStart
  | TrieQuery
  | TrieResponse
  | EditSet
  | EditBatch
  | FullState;

// -------------------------------------------------------
// Encode
// -------------------------------------------------------

export function encodeMessage(msg: Message): Uint8Array {
  const enc = createEncoder();
  writeVarUint(enc, msg.type);

  switch (msg.type) {
    case MessageType.RECONCILE_START:
      writeVarString(enc, msg.channel);
      writeVarUint8Array(enc, msg.fingerprint);
      writeVarUint(enc, msg.editCount);
      break;

    case MessageType.TRIE_QUERY:
      writeVarString(enc, msg.channel);
      writeVarUint8Array(enc, msg.prefix);
      writeVarUint(enc, msg.depth);
      writeVarUint8Array(enc, msg.fingerprint);
      writeVarUint(enc, msg.editCount);
      break;

    case MessageType.TRIE_RESPONSE:
      writeVarString(enc, msg.channel);
      writeVarUint8Array(enc, msg.prefix);
      writeVarUint(enc, msg.depth);
      writeVarUint8Array(enc, msg.fingerprint);
      writeVarUint(enc, msg.match ? 1 : 0);
      break;

    case MessageType.EDIT_SET:
      writeVarString(enc, msg.channel);
      writeVarUint8Array(enc, msg.prefix);
      writeVarUint(enc, msg.depth);
      writeVarUint(enc, msg.hashes.length);
      for (const h of msg.hashes) {
        writeVarUint8Array(enc, h);
      }
      break;

    case MessageType.EDIT_BATCH:
      writeVarString(enc, msg.channel);
      writeVarUint(enc, msg.edits.length);
      for (const e of msg.edits) {
        writeVarUint8Array(enc, e.payload);
        writeVarUint8Array(enc, e.signature);
      }
      break;

    case MessageType.FULL_STATE:
      writeVarString(enc, msg.channel);
      writeVarUint8Array(enc, msg.snapshot);
      break;
  }

  return toUint8Array(enc);
}

// -------------------------------------------------------
// Decode
// -------------------------------------------------------

export function decodeMessage(bytes: Uint8Array): Message {
  const dec = createDecoder(bytes);
  const type = readVarUint(dec) as MessageType;

  switch (type) {
    case MessageType.RECONCILE_START:
      return {
        type,
        channel: readVarString(dec),
        fingerprint: readVarUint8Array(dec),
        editCount: readVarUint(dec),
      };

    case MessageType.TRIE_QUERY:
      return {
        type,
        channel: readVarString(dec),
        prefix: readVarUint8Array(dec),
        depth: readVarUint(dec),
        fingerprint: readVarUint8Array(dec),
        editCount: readVarUint(dec),
      };

    case MessageType.TRIE_RESPONSE: {
      const channel = readVarString(dec);
      const prefix = readVarUint8Array(dec);
      const depth = readVarUint(dec);
      const fingerprint = readVarUint8Array(dec);
      const match = readVarUint(dec) === 1;
      return {
        type,
        channel,
        prefix,
        depth,
        fingerprint,
        match,
      };
    }

    case MessageType.EDIT_SET: {
      const channel = readVarString(dec);
      const prefix = readVarUint8Array(dec);
      const depth = readVarUint(dec);
      const count = readVarUint(dec);
      const hashes: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        hashes.push(readVarUint8Array(dec));
      }
      return { type, channel, prefix, depth, hashes };
    }

    case MessageType.EDIT_BATCH: {
      const channel = readVarString(dec);
      const count = readVarUint(dec);
      const edits: Array<{
        payload: Uint8Array;
        signature: Uint8Array;
      }> = [];
      for (let i = 0; i < count; i++) {
        edits.push({
          payload: readVarUint8Array(dec),
          signature: readVarUint8Array(dec),
        });
      }
      return { type, channel, edits };
    }

    case MessageType.FULL_STATE:
      return {
        type,
        channel: readVarString(dec),
        snapshot: readVarUint8Array(dec),
      };

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
