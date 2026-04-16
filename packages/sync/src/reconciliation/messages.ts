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
  writeFloat64,
  toUint8Array,
} from "lib0/encoding";
import {
  createDecoder,
  readVarUint,
  readVarString,
  readVarUint8Array,
  readFloat64,
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
  SNAPSHOT_CATALOG: 6,
  SNAPSHOT_REQUEST: 7,
  SNAPSHOT_BLOCK: 8,
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

/**
 * Advertise locally-available snapshot CIDs.
 * Per-document (no channel field) — snapshot CIDs
 * span all channels.
 */
export interface SnapshotCatalog {
  type: typeof MessageType.SNAPSHOT_CATALOG;
  entries: Array<{
    /** Snapshot block CID bytes. */
    cid: Uint8Array;
    /** IPNS sequence number for this snapshot. */
    seq: number;
    /** Materialization timestamp (ms). */
    ts: number;
  }>;
  /** CID of current tip, or null if unknown. */
  tip: Uint8Array | null;
}

/**
 * Request a set of snapshot CIDs by hash.
 */
export interface SnapshotRequest {
  type: typeof MessageType.SNAPSHOT_REQUEST;
  cids: Uint8Array[];
}

/**
 * One chunk of a snapshot block. Large blocks are
 * split into ~200KB chunks; receiver reassembles
 * by cid + offset.
 *
 * NAK: empty `block` with `total === 0` signals
 * the responder can't serve this CID.
 */
export interface SnapshotBlock {
  type: typeof MessageType.SNAPSHOT_BLOCK;
  cid: Uint8Array;
  /** Chunk bytes; empty = NAK. */
  block: Uint8Array;
  /** Byte offset of this chunk in the full block. */
  offset: number;
  /** Total block size; 0 = NAK. */
  total: number;
  /** Final chunk of the final CID in this response. */
  last: boolean;
}

export type Message =
  | ReconcileStart
  | TrieQuery
  | TrieResponse
  | EditSet
  | EditBatch
  | FullState
  | SnapshotCatalog
  | SnapshotRequest
  | SnapshotBlock;

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

    case MessageType.SNAPSHOT_CATALOG:
      writeVarUint(enc, msg.entries.length);
      for (const e of msg.entries) {
        writeVarUint8Array(enc, e.cid);
        writeVarUint(enc, e.seq);
        writeFloat64(enc, e.ts);
      }
      writeVarUint(enc, msg.tip !== null ? 1 : 0);
      if (msg.tip !== null) {
        writeVarUint8Array(enc, msg.tip);
      }
      break;

    case MessageType.SNAPSHOT_REQUEST:
      writeVarUint(enc, msg.cids.length);
      for (const cid of msg.cids) {
        writeVarUint8Array(enc, cid);
      }
      break;

    case MessageType.SNAPSHOT_BLOCK:
      writeVarUint8Array(enc, msg.cid);
      writeVarUint8Array(enc, msg.block);
      writeVarUint(enc, msg.offset);
      writeVarUint(enc, msg.total);
      writeVarUint(enc, msg.last ? 1 : 0);
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

    case MessageType.SNAPSHOT_CATALOG: {
      const count = readVarUint(dec);
      const entries: SnapshotCatalog["entries"] = [];
      for (let i = 0; i < count; i++) {
        entries.push({
          cid: readVarUint8Array(dec),
          seq: readVarUint(dec),
          ts: readFloat64(dec),
        });
      }
      const hasTip = readVarUint(dec) === 1;
      const tip = hasTip ? readVarUint8Array(dec) : null;
      return { type, entries, tip };
    }

    case MessageType.SNAPSHOT_REQUEST: {
      const count = readVarUint(dec);
      const cids: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        cids.push(readVarUint8Array(dec));
      }
      return { type, cids };
    }

    case MessageType.SNAPSHOT_BLOCK: {
      const cid = readVarUint8Array(dec);
      const block = readVarUint8Array(dec);
      const offset = readVarUint(dec);
      const total = readVarUint(dec);
      const last = readVarUint(dec) === 1;
      return { type, cid, block, offset, total, last };
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
