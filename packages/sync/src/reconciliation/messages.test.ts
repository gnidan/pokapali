import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  encodeMessage,
  decodeMessage,
  MessageType,
  type Message,
} from "./messages.js";

// -------------------------------------------------------
// Arbitraries
// -------------------------------------------------------

const fingerprint32 = fc.uint8Array({
  minLength: 32,
  maxLength: 32,
});
const varBytes = fc.uint8Array({
  minLength: 0,
  maxLength: 200,
});
const channel = fc.string({ minLength: 0, maxLength: 50 });

const arbReconcileStart = fc.record({
  type: fc.constant(MessageType.RECONCILE_START),
  channel,
  fingerprint: fingerprint32,
  editCount: fc.nat({ max: 0xffff }),
});

const arbTrieQuery = fc.record({
  type: fc.constant(MessageType.TRIE_QUERY),
  channel,
  prefix: varBytes,
  depth: fc.nat({ max: 256 }),
  fingerprint: fingerprint32,
  editCount: fc.nat({ max: 10000 }),
});

const arbTrieResponse = fc.record({
  type: fc.constant(MessageType.TRIE_RESPONSE),
  channel,
  prefix: varBytes,
  depth: fc.nat({ max: 256 }),
  fingerprint: fingerprint32,
  match: fc.boolean(),
});

const arbEditSet = fc.record({
  type: fc.constant(MessageType.EDIT_SET),
  channel,
  prefix: varBytes,
  depth: fc.nat({ max: 256 }),
  hashes: fc.array(fingerprint32, { maxLength: 20 }),
});

const arbEditBatch = fc.record({
  type: fc.constant(MessageType.EDIT_BATCH),
  channel,
  edits: fc.array(
    fc.record({
      payload: varBytes,
      signature: fc.uint8Array({
        minLength: 0,
        maxLength: 64,
      }),
    }),
    { maxLength: 10 },
  ),
});

const arbFullState = fc.record({
  type: fc.constant(MessageType.FULL_STATE),
  channel,
  snapshot: varBytes,
});

const arbMessage: fc.Arbitrary<Message> = fc.oneof(
  arbReconcileStart,
  arbTrieQuery,
  arbTrieResponse,
  arbEditSet,
  arbEditBatch,
  arbFullState,
);

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function deepEqualMsg(a: Message, b: Message): void {
  expect(a.type).toBe(b.type);
  expect(a.channel).toBe(b.channel);

  switch (a.type) {
    case MessageType.RECONCILE_START: {
      const bb = b as typeof a;
      expect(a.fingerprint).toEqual(bb.fingerprint);
      expect(a.editCount).toBe(bb.editCount);
      break;
    }
    case MessageType.TRIE_QUERY: {
      const bb = b as typeof a;
      expect(a.prefix).toEqual(bb.prefix);
      expect(a.depth).toBe(bb.depth);
      expect(a.fingerprint).toEqual(bb.fingerprint);
      expect(a.editCount).toBe(bb.editCount);
      break;
    }
    case MessageType.TRIE_RESPONSE: {
      const bb = b as typeof a;
      expect(a.prefix).toEqual(bb.prefix);
      expect(a.depth).toBe(bb.depth);
      expect(a.fingerprint).toEqual(bb.fingerprint);
      expect(a.match).toBe(bb.match);
      break;
    }
    case MessageType.EDIT_SET: {
      const bb = b as typeof a;
      expect(a.prefix).toEqual(bb.prefix);
      expect(a.depth).toBe(bb.depth);
      expect(a.hashes).toHaveLength(bb.hashes.length);
      for (let i = 0; i < a.hashes.length; i++) {
        expect(a.hashes[i]).toEqual(bb.hashes[i]);
      }
      break;
    }
    case MessageType.EDIT_BATCH: {
      const bb = b as typeof a;
      expect(a.edits).toHaveLength(bb.edits.length);
      for (let i = 0; i < a.edits.length; i++) {
        expect(a.edits[i]!.payload).toEqual(bb.edits[i]!.payload);
        expect(a.edits[i]!.signature).toEqual(bb.edits[i]!.signature);
      }
      break;
    }
    case MessageType.FULL_STATE: {
      const bb = b as typeof a;
      expect(a.snapshot).toEqual(bb.snapshot);
      break;
    }
  }
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("protocol messages", () => {
  describe("round-trip property tests", () => {
    it("any message survives encode/decode", () => {
      fc.assert(
        fc.property(arbMessage, (msg) => {
          const bytes = encodeMessage(msg);
          const decoded = decodeMessage(bytes);
          deepEqualMsg(msg, decoded);
        }),
        { numRuns: 500 },
      );
    });

    it("ReconcileStart round-trip", () => {
      fc.assert(
        fc.property(arbReconcileStart, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("TrieQuery round-trip", () => {
      fc.assert(
        fc.property(arbTrieQuery, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("TrieResponse round-trip", () => {
      fc.assert(
        fc.property(arbTrieResponse, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("EditSet round-trip", () => {
      fc.assert(
        fc.property(arbEditSet, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("EditBatch round-trip", () => {
      fc.assert(
        fc.property(arbEditBatch, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });

    it("FullState round-trip", () => {
      fc.assert(
        fc.property(arbFullState, (msg) => {
          deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("edge cases", () => {
    it("empty channel name", () => {
      const msg: Message = {
        type: MessageType.RECONCILE_START,
        channel: "",
        fingerprint: new Uint8Array(32),
        editCount: 0,
      };
      deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
    });

    it("zero-length hashes array", () => {
      const msg: Message = {
        type: MessageType.EDIT_SET,
        channel: "content",
        prefix: new Uint8Array(4),
        depth: 8,
        hashes: [],
      };
      deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
    });

    it("zero-length edits array", () => {
      const msg: Message = {
        type: MessageType.EDIT_BATCH,
        channel: "content",
        edits: [],
      };
      deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
    });

    it("large payload in EditBatch", () => {
      const msg: Message = {
        type: MessageType.EDIT_BATCH,
        channel: "content",
        edits: [
          {
            payload: new Uint8Array(10000).fill(0xab),
            signature: new Uint8Array(64).fill(0xcd),
          },
        ],
      };
      deepEqualMsg(msg, decodeMessage(encodeMessage(msg)));
    });

    it("unknown message type throws", () => {
      const enc = new Uint8Array([99]);
      expect(() => decodeMessage(enc)).toThrow(/Unknown message type/);
    });
  });
});
