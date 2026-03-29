import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  buildTrie,
  queryPrefix,
  collectHashes,
  type TrieNode,
  type InternalNode,
} from "./merkle-trie.js";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/** XOR-fold an array of equal-length byte arrays. */
function xorAll(bufs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(32);
  for (const b of bufs) {
    for (let i = 0; i < 32; i++) {
      out[i]! ^= b[i]!;
    }
  }
  return out;
}

/** Return bit `i` (MSB-first) of `buf`. */
function getBit(buf: Uint8Array, i: number): 0 | 1 {
  const byteIdx = i >>> 3;
  const bitOff = 7 - (i & 7);
  return ((buf[byteIdx]! >>> bitOff) & 1) as 0 | 1;
}

/**
 * Create a deterministic 32-byte "hash" from a seed byte.
 * Not cryptographic — just for testing structure.
 */
function fakeHash(seed: number): Uint8Array {
  const h = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    h[i] = (seed * 37 + i * 13) & 0xff;
  }
  return h;
}

function rootFingerprint(trie: TrieNode): Uint8Array {
  return trie.kind === "leaf" ? trie.hash : trie.fingerprint;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("merkle-trie", () => {
  // -- Empty trie --

  describe("empty trie", () => {
    it("has zero fingerprint and zero edit count", () => {
      const trie = buildTrie([]);
      expect(trie.kind).toBe("internal");
      const node = trie as InternalNode;
      expect(node.fingerprint).toEqual(new Uint8Array(32));
      expect(node.editCount).toBe(0);
    });

    it("queryPrefix returns zero fingerprint", () => {
      const trie = buildTrie([]);
      const result = queryPrefix(trie, new Uint8Array(32), 0);
      expect(result.editCount).toBe(0);
      expect(result.fingerprint).toEqual(new Uint8Array(32));
    });

    it("collectHashes returns empty array", () => {
      const trie = buildTrie([]);
      const hashes = collectHashes(trie, new Uint8Array(32), 0);
      expect(hashes).toEqual([]);
    });
  });

  // -- Single-edit trie --

  describe("single-edit trie", () => {
    it("root fingerprint equals the hash itself", () => {
      const h = fakeHash(42);
      const trie = buildTrie([h]);
      expect(rootFingerprint(trie)).toEqual(h);
    });

    it("collectHashes at depth 0 returns the hash", () => {
      const h = fakeHash(42);
      const trie = buildTrie([h]);
      const result = collectHashes(trie, new Uint8Array(32), 0);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(h);
    });

    it("queryPrefix at depth 0 shows editCount 1", () => {
      const h = fakeHash(42);
      const trie = buildTrie([h]);
      const result = queryPrefix(trie, new Uint8Array(32), 0);
      expect(result.editCount).toBe(1);
      expect(result.fingerprint).toEqual(h);
    });
  });

  // -- Known hash set --

  describe("known hash set", () => {
    const hashes = [
      fakeHash(1),
      fakeHash(2),
      fakeHash(3),
      fakeHash(4),
      fakeHash(5),
    ];
    const trie = buildTrie(hashes);

    it("root fingerprint equals XOR of all hashes", () => {
      expect(rootFingerprint(trie)).toEqual(xorAll(hashes));
    });

    it("collectHashes at depth 0 returns all", () => {
      const collected = collectHashes(trie, new Uint8Array(32), 0);
      expect(collected).toHaveLength(hashes.length);
      // Every original hash must appear.
      for (const h of hashes) {
        expect(
          collected.some(
            (c) => c.length === h.length && c.every((v, i) => v === h[i]),
          ),
        ).toBe(true);
      }
    });

    it("queryPrefix at depth 0 has correct editCount", () => {
      const result = queryPrefix(trie, new Uint8Array(32), 0);
      expect(result.editCount).toBe(5);
    });
  });

  // -- Prefix queries narrow correctly --

  describe("prefix queries", () => {
    it("narrows to correct subset", () => {
      const hashes = Array.from({ length: 20 }, (_, i) => fakeHash(i));
      const trie = buildTrie(hashes);

      // Query at depth 1 with bit 0 = 0 should give
      // only hashes whose first bit is 0.
      const prefix0 = new Uint8Array(32); // all zeros
      const result0 = queryPrefix(trie, prefix0, 1);

      const expected0 = hashes.filter((h) => getBit(h, 0) === 0);
      expect(result0.editCount).toBe(expected0.length);
      expect(result0.fingerprint).toEqual(xorAll(expected0));

      // And collectHashes agrees.
      const collected0 = collectHashes(trie, prefix0, 1);
      expect(collected0).toHaveLength(expected0.length);
    });

    it("deeper prefix further narrows the subset", () => {
      const hashes = Array.from({ length: 50 }, (_, i) => fakeHash(i * 7));
      const trie = buildTrie(hashes);

      // Depth-2 prefix with bits 1,0.
      const prefix = new Uint8Array(32);
      prefix[0] = 0b01000000; // bit0=0, bit1=1
      const result = queryPrefix(trie, prefix, 2);

      const expected = hashes.filter(
        (h) => getBit(h, 0) === 0 && getBit(h, 1) === 1,
      );
      expect(result.editCount).toBe(expected.length);
      expect(result.fingerprint).toEqual(xorAll(expected));
    });

    it("non-matching prefix returns zero", () => {
      // Build trie with a single hash and query a
      // prefix that diverges at bit 0.
      const h = new Uint8Array(32);
      h[0] = 0b10000000; // first bit = 1
      const trie = buildTrie([h]);

      const wrongPrefix = new Uint8Array(32);
      wrongPrefix[0] = 0b00000000; // first bit = 0
      const result = queryPrefix(trie, wrongPrefix, 1);
      expect(result.editCount).toBe(0);
    });
  });

  // -- Duplicate hashes --

  describe("duplicate hashes", () => {
    it("are deduplicated", () => {
      const h = fakeHash(99);
      const trie = buildTrie([h, h, h]);
      const collected = collectHashes(trie, new Uint8Array(32), 0);
      expect(collected).toHaveLength(1);
    });
  });

  // -- Property tests --

  describe("property tests", () => {
    const hashArb = fc.uint8Array({
      minLength: 32,
      maxLength: 32,
    });

    it("root fingerprint === xorAll(hashes) " + "for any hash set", () => {
      fc.assert(
        fc.property(
          fc.array(hashArb, {
            minLength: 0,
            maxLength: 100,
          }),
          (hashes) => {
            const trie = buildTrie(hashes);
            // Deduplicate for the expected XOR since
            // the trie deduplicates.
            const seen = new Set<string>();
            const unique: Uint8Array[] = [];
            for (const h of hashes) {
              const key = Array.from(h).join(",");
              if (!seen.has(key)) {
                seen.add(key);
                unique.push(h);
              }
            }
            const expected = xorAll(unique);
            const actual = rootFingerprint(trie);
            expect(actual).toEqual(expected);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("collectHashes at depth 0 returns all " + "unique hashes", () => {
      fc.assert(
        fc.property(
          fc.array(hashArb, {
            minLength: 0,
            maxLength: 50,
          }),
          (hashes) => {
            const trie = buildTrie(hashes);
            const collected = collectHashes(trie, new Uint8Array(32), 0);

            const seen = new Set<string>();
            for (const h of hashes) {
              seen.add(Array.from(h).join(","));
            }
            expect(collected).toHaveLength(seen.size);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("left + right editCounts sum to root editCount", () => {
      fc.assert(
        fc.property(
          fc.array(hashArb, {
            minLength: 2,
            maxLength: 80,
          }),
          (hashes) => {
            const trie = buildTrie(hashes);
            if (trie.kind !== "internal") return;

            const prefix0 = new Uint8Array(32);
            const prefix1 = new Uint8Array(32);
            prefix1[0] = 0b10000000;

            const r0 = queryPrefix(trie, prefix0, 1);
            const r1 = queryPrefix(trie, prefix1, 1);

            const root = queryPrefix(trie, new Uint8Array(32), 0);
            expect(r0.editCount + r1.editCount).toBe(root.editCount);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("insertion order does not affect root fingerprint", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(hashArb, {
            minLength: 1,
            maxLength: 50,
            selector: (h) => Array.from(h).join(","),
          }),
          (hashes) => {
            const shuffled = [...hashes].sort(() => Math.random() - 0.5);
            const trie1 = buildTrie(hashes);
            const trie2 = buildTrie(shuffled);
            const fp1 = trie1.kind === "leaf" ? trie1.hash : trie1.fingerprint;
            const fp2 = trie2.kind === "leaf" ? trie2.hash : trie2.fingerprint;
            expect(fp1).toEqual(fp2);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
