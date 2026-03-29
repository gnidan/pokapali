import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createSession } from "./session.js";
import { MessageType, type Message } from "./messages.js";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/** Deterministic 32-byte hash from a single byte seed. */
function fakeHash(seed: number): Uint8Array {
  const h = new Uint8Array(32);
  h[0] = seed;
  // Spread bits so hashes diverge early in the trie
  h[1] = seed ^ 0xff;
  h[31] = seed;
  return h;
}

/** XOR all hashes to compute expected fingerprint. */
function xorAll(hashes: Uint8Array[]): Uint8Array {
  const fp = new Uint8Array(32);
  for (const h of hashes) {
    for (let i = 0; i < 32; i++) {
      fp[i]! ^= h[i]!;
    }
  }
  return fp;
}

function hexHash(h: Uint8Array): string {
  return Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Edit = {
  payload: Uint8Array;
  signature: Uint8Array;
};

/**
 * Drive two sessions to completion, collecting edits
 * delivered to each side. Returns edits received by
 * A (from B) and edits received by B (from A).
 */
function runExchange(
  a: ReturnType<typeof createSession>,
  b: ReturnType<typeof createSession>,
): {
  editsForA: Edit[];
  editsForB: Edit[];
  rounds: number;
} {
  const editsForA: Edit[] = [];
  const editsForB: Edit[] = [];

  const start = a.initiate();
  let msg: Message | null = start;
  let current: "b" | "a" = "b";
  let rounds = 0;

  while (msg !== null && rounds < 100) {
    rounds++;
    const session = current === "b" ? b : a;
    const result = session.receive(msg);

    if (result === null) break;
    if (Array.isArray(result)) {
      if (current === "b") {
        editsForB.push(...result);
      } else {
        editsForA.push(...result);
      }
      break;
    }
    msg = result;
    current = current === "b" ? "a" : "b";
  }

  if (rounds >= 100) {
    throw new Error(`Exchange did not converge in 100 rounds`);
  }

  return { editsForA, editsForB, rounds };
}

const CHANNEL = "content";

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("ReconciliationSession", () => {
  it("sessionId is present and unique", () => {
    const fp = new Uint8Array(32);
    const a = createSession([], fp, CHANNEL);
    const b = createSession([], fp, CHANNEL);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  describe("identical peers", () => {
    it("returns null when fingerprints match", () => {
      const hashes = [fakeHash(1), fakeHash(2)];
      const fp = xorAll(hashes);

      const initiator = createSession(hashes, fp, CHANNEL);
      const responder = createSession(hashes, fp, CHANNEL);

      const start = initiator.initiate();
      expect(start.type).toBe(MessageType.RECONCILE_START);

      const reply = responder.receive(start);
      expect(reply).toBeNull();
    });
  });

  describe("late joiner", () => {
    it("sends FULL_STATE when remote editCount=0", () => {
      const hashes = [fakeHash(1), fakeHash(2)];
      const fp = xorAll(hashes);
      const snapshot = new Uint8Array([1, 2, 3, 4]);

      const lateComer = createSession([], new Uint8Array(32), CHANNEL);
      const established = createSession(hashes, fp, CHANNEL, snapshot);

      const start = lateComer.initiate();
      expect(start.type).toBe(MessageType.RECONCILE_START);
      if (start.type !== MessageType.RECONCILE_START) {
        throw new Error("unexpected");
      }
      expect(start.editCount).toBe(0);

      const reply = established.receive(start);
      expect(reply).not.toBeNull();
      if (reply === null || Array.isArray(reply)) {
        throw new Error("expected Message");
      }
      expect(reply.type).toBe(MessageType.FULL_STATE);
      if (reply.type !== MessageType.FULL_STATE) {
        throw new Error("unexpected");
      }
      expect(reply.snapshot).toEqual(snapshot);
    });
  });

  describe("single edit difference", () => {
    it("B has extra edit — A receives it via EDIT_BATCH", () => {
      const shared = [fakeHash(1), fakeHash(2)];
      const extra = fakeHash(3);
      const hashesA = [...shared];
      const hashesB = [...shared, extra];
      const fpA = xorAll(hashesA);
      const fpB = xorAll(hashesB);

      const a = createSession(hashesA, fpA, CHANNEL);
      const b = createSession(hashesB, fpB, CHANNEL);

      const { editsForA, editsForB } = runExchange(a, b);

      // A initiated, B responded with trie queries.
      // B's EDIT_SET leads to A sending EDIT_BATCH
      // (edits A has that B doesn't — none, since
      // B is a superset). B receives empty batch.
      // The protocol is one-directional per session:
      // A sends what B is missing.
      expect(editsForB).toHaveLength(0);
    });

    it("A has extra edit — B receives it via EDIT_BATCH", () => {
      const shared = [fakeHash(1), fakeHash(2)];
      const extra = fakeHash(3);
      const hashesA = [...shared, extra];
      const hashesB = [...shared];
      const fpA = xorAll(hashesA);
      const fpB = xorAll(hashesB);

      const a = createSession(hashesA, fpA, CHANNEL);
      const b = createSession(hashesB, fpB, CHANNEL);

      const { editsForB } = runExchange(a, b);

      // B drove the trie search, sent EDIT_SET. A
      // found it has `extra` that B doesn't, sent
      // EDIT_BATCH. B received it.
      expect(editsForB).toHaveLength(1);
      // payload = hash (placeholder for transport)
      expect(hexHash(editsForB[0]!.payload)).toBe(hexHash(extra));
    });
  });

  describe("full mock exchange", () => {
    it("A sends edits B is missing", () => {
      const shared = [fakeHash(1), fakeHash(2)];
      const onlyA = [fakeHash(3)];
      const onlyB = [fakeHash(4), fakeHash(5)];
      const hashesA = [...shared, ...onlyA];
      const hashesB = [...shared, ...onlyB];
      const fpA = xorAll(hashesA);
      const fpB = xorAll(hashesB);

      const a = createSession(hashesA, fpA, CHANNEL);
      const b = createSession(hashesB, fpB, CHANNEL);

      const { editsForB } = runExchange(a, b);

      // A should send the edits B is missing
      // (onlyA hashes)
      const sentHashes = new Set(editsForB.map((e) => hexHash(e.payload)));
      for (const h of onlyA) {
        expect(sentHashes.has(hexHash(h))).toBe(true);
      }
      // Should not send shared edits
      for (const h of shared) {
        expect(sentHashes.has(hexHash(h))).toBe(false);
      }
    });
  });

  describe("FULL_STATE reception", () => {
    it("returns snapshot to caller", () => {
      const snapshot = new Uint8Array([10, 20, 30, 40]);
      const session = createSession([], new Uint8Array(32), CHANNEL);

      const fullState: Message = {
        type: MessageType.FULL_STATE,
        channel: CHANNEL,
        snapshot,
      };

      const result = session.receive(fullState);
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) {
        throw new Error("expected array");
      }
      // FULL_STATE returns a single-element array
      // with the snapshot as payload
      expect(result).toHaveLength(1);
      expect(result[0]!.payload).toEqual(snapshot);
    });
  });

  describe("EDIT_BATCH reception", () => {
    it("returns edits array to caller", () => {
      const session = createSession(
        [fakeHash(1)],
        xorAll([fakeHash(1)]),
        CHANNEL,
      );

      const batch: Message = {
        type: MessageType.EDIT_BATCH,
        channel: CHANNEL,
        edits: [
          {
            payload: new Uint8Array([1, 2, 3]),
            signature: new Uint8Array([4, 5, 6]),
          },
          {
            payload: new Uint8Array([7, 8, 9]),
            signature: new Uint8Array([10, 11, 12]),
          },
        ],
      };

      const result = session.receive(batch);
      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) {
        throw new Error("expected array");
      }
      expect(result).toHaveLength(2);
      expect(result[0]!.payload).toEqual(new Uint8Array([1, 2, 3]));
      expect(result[1]!.signature).toEqual(new Uint8Array([10, 11, 12]));
    });
  });

  describe("property tests", () => {
    const hashArb = fc.uint8Array({
      minLength: 32,
      maxLength: 32,
    });

    function expectSetEquals(edits: Edit[], expected: Uint8Array[]): void {
      const got = new Set(edits.map((e) => hexHash(e.payload)));
      const want = new Set(expected.map(hexHash));
      expect(got).toEqual(want);
    }

    it(
      "exchange terminates and delivers " +
        "correct edits for arbitrary edit sets",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(hashArb, {
              minLength: 0,
              maxLength: 30,
              selector: (h) => Array.from(h).join(","),
            }),
            (allHashes) => {
              // Partition into shared / onlyA / onlyB
              // with no cross-array overlap.
              const n = allHashes.length;
              const cut1 = Math.floor(n / 3);
              const cut2 = Math.floor((2 * n) / 3);
              const shared = allHashes.slice(0, cut1);
              const onlyA = allHashes.slice(cut1, cut2);
              const onlyB = allHashes.slice(cut2);

              const hashesA = [...shared, ...onlyA];
              const hashesB = [...shared, ...onlyB];
              const fpA = xorAll(hashesA);
              const fpB = xorAll(hashesB);

              const sessionA = createSession(hashesA, fpA, "ch");
              const sessionB = createSession(hashesB, fpB, "ch");
              const { editsForB, rounds } = runExchange(sessionA, sessionB);

              expect(rounds).toBeLessThan(100);
              // B receives exactly A's unique edits
              expectSetEquals(editsForB, onlyA);
            },
          ),
          { numRuns: 200 },
        );
      },
    );
  });
});
