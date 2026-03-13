/**
 * Tests for author verification in @pokapali/comments.
 *
 * STATUS: stubs only — fill in assertions when:
 * 1. Core's auth Phase 1 (clientID→pubkey mapping)
 *    merges to main
 * 2. Comments package implementation lands
 *
 * Author verification flow:
 * - Session opens → core registers
 *   { [clientID]: { pubkey, sig } } in _meta
 * - sig = sign(pubkey + ":" + docId, identityKey)
 * - Comment's Y.Map item tagged with creator's
 *   clientID (Yjs internal)
 * - Verification: look up item.id.client in
 *   mapping, verify sig, confirm matches author field
 * - One signature per session covers all operations
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

// ── Helpers ─────────────────────────────────────────

const AUTHOR_A = "aa".repeat(16);
const AUTHOR_B = "bb".repeat(16);
const AUTHOR_C = "cc".repeat(16);

/**
 * Create a mock clientID→pubkey mapping.
 * In production this comes from _meta subdoc.
 */
function createMockMapping(
  entries: Array<{
    clientId: number;
    pubkey: string;
    sig: string;
    valid: boolean;
  }>,
) {
  // Will be replaced with real Feed<Map<...>> from
  // core's clientIdMapping once auth Phase 1 lands.
  const map = new Map<number, { pubkey: string; sig: string }>();
  for (const e of entries) {
    map.set(e.clientId, {
      pubkey: e.pubkey,
      sig: e.sig,
    });
  }
  return map;
}

// ── Author verification ────────────────────────────

describe("author verification", () => {
  it("valid mapping + matching author → " + "authorVerified: true", () => {
    // const mapping = createMockMapping([
    //   { clientId: 1, pubkey: AUTHOR_A,
    //     sig: "valid-sig", valid: true },
    // ]);
    // const c = comments<{}>(..., {
    //   author: AUTHOR_A,
    //   clientIdMapping: mapping,
    // });
    // c.add({ content: "Hello", data: {} });
    // const comment = c.feed.getSnapshot()[0];
    // expect(comment.authorVerified).toBe(true);
    expect(true).toBe(true); // stub
  });

  it(
    "valid mapping but author field " + "doesn't match → authorVerified: false",
    () => {
      // Mapping says clientId 1 → AUTHOR_A
      // But comment's author field is AUTHOR_B
      // (shouldn't happen in honest use, but
      // verifier should catch it)
      expect(true).toBe(true); // stub
    },
  );

  it("missing mapping for clientID → " + "authorVerified: false", () => {
    // Comment created by clientId 99 but
    // no mapping exists for clientId 99
    // → authorVerified: false
    expect(true).toBe(true); // stub
  });

  it("invalid signature in mapping → " + "authorVerified: false", () => {
    // Mapping has entry for clientId but sig
    // doesn't verify → authorVerified: false
    expect(true).toBe(true); // stub
  });

  it(
    "late registration: mapping arrives " +
      "after comment → feed updates " +
      "authorVerified",
    () => {
      // 1. Comment added (no mapping yet)
      //    → authorVerified: false
      // 2. Mapping arrives via _meta sync
      //    → feed re-emits with authorVerified: true
      expect(true).toBe(true); // stub
    },
  );

  it(
    "multiple clients, each with own " +
      "mapping → each verified " +
      "independently",
    () => {
      // Client A (clientId 1) → AUTHOR_A: verified
      // Client B (clientId 2) → AUTHOR_B: verified
      // Client C (clientId 3) → no mapping: unverified
      expect(true).toBe(true); // stub
    },
  );
});
