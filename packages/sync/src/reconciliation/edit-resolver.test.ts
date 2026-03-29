import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { Channel, Edit, Epoch, Boundary } from "@pokapali/document";
import { toArray } from "@pokapali/finger-tree";
import {
  collectEditHashes,
  buildEditIndex,
  channelFingerprint,
} from "./edit-resolver.js";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeEdit(payload: Uint8Array): Edit {
  return Edit.create({
    payload,
    timestamp: Date.now(),
    author: "test-author",
    channel: "content",
    origin: "local",
    signature: new Uint8Array(),
  });
}

function xorAll(bufs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(32);
  for (const b of bufs) {
    for (let i = 0; i < 32; i++) {
      out[i]! ^= b[i]!;
    }
  }
  return out;
}

function hexHash(h: Uint8Array): string {
  return Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("edit-resolver", () => {
  describe("collectEditHashes", () => {
    it(
      "returns sha256 of each edit payload " + "across multiple epochs",
      () => {
        const ch = Channel.create("content");
        const e1 = makeEdit(new Uint8Array([1, 2, 3]));
        const e2 = makeEdit(new Uint8Array([4, 5, 6]));
        const e3 = makeEdit(new Uint8Array([7, 8, 9]));

        ch.appendEdit(e1);
        ch.appendEdit(e2);
        ch.closeEpoch();
        ch.appendEdit(e3);

        const hashes = collectEditHashes(ch);

        expect(hashes).toHaveLength(3);
        expect(hashes[0]).toEqual(sha256(e1.payload));
        expect(hashes[1]).toEqual(sha256(e2.payload));
        expect(hashes[2]).toEqual(sha256(e3.payload));
      },
    );

    it("returns empty array for empty channel", () => {
      const ch = Channel.create("content");
      const hashes = collectEditHashes(ch);
      expect(hashes).toHaveLength(0);
    });
  });

  describe("buildEditIndex", () => {
    it("maps hex hash to original Edit", () => {
      const ch = Channel.create("content");
      const e1 = makeEdit(new Uint8Array([10, 20]));
      const e2 = makeEdit(new Uint8Array([30, 40]));

      ch.appendEdit(e1);
      ch.appendEdit(e2);

      const index = buildEditIndex(ch);

      expect(index.size).toBe(2);

      const h1 = hexHash(sha256(e1.payload));
      const h2 = hexHash(sha256(e2.payload));

      expect(index.get(h1)).toBeDefined();
      expect(index.get(h1)!.payload).toEqual(e1.payload);
      expect(index.get(h2)).toBeDefined();
      expect(index.get(h2)!.payload).toEqual(e2.payload);
    });

    it("returns empty map for empty channel", () => {
      const ch = Channel.create("content");
      const index = buildEditIndex(ch);
      expect(index.size).toBe(0);
    });

    it("deduplicates edits with identical " + "payloads", () => {
      const ch = Channel.create("content");
      const payload = new Uint8Array([1, 2, 3]);
      ch.appendEdit(makeEdit(payload));
      ch.appendEdit(makeEdit(payload));

      const index = buildEditIndex(ch);

      // Same payload → same hash → one entry
      expect(index.size).toBe(1);
    });
  });

  describe("channelFingerprint", () => {
    it("equals XOR of all edit hashes", () => {
      const ch = Channel.create("content");
      const e1 = makeEdit(new Uint8Array([1, 2, 3]));
      const e2 = makeEdit(new Uint8Array([4, 5, 6]));
      const e3 = makeEdit(new Uint8Array([7, 8, 9]));

      ch.appendEdit(e1);
      ch.appendEdit(e2);
      ch.closeEpoch();
      ch.appendEdit(e3);

      const fp = channelFingerprint(ch);
      const expected = xorAll([
        sha256(e1.payload),
        sha256(e2.payload),
        sha256(e3.payload),
      ]);

      expect(fp).toEqual(expected);
    });

    it("returns 32 zero bytes for empty " + "channel", () => {
      const ch = Channel.create("content");
      const fp = channelFingerprint(ch);
      expect(fp).toEqual(new Uint8Array(32));
    });

    it(
      "duplicate payloads produce identical " + "hashes that cancel in XOR",
      () => {
        const ch = Channel.create("content");
        const payload = new Uint8Array([99]);
        ch.appendEdit(makeEdit(payload));
        ch.appendEdit(makeEdit(payload));

        const fp = channelFingerprint(ch);

        // Two identical hashes XOR to zero
        expect(fp).toEqual(new Uint8Array(32));
      },
    );
  });
});
