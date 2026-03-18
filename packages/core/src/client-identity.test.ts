/**
 * Tests for clientID→pubkey mapping (Auth Phase 1):
 * - clientIdentities Y.Map registration
 * - Signature verification
 * - Y.Map merge semantics across peers
 * - Multiple sessions produce distinct entries
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { bytesToHex, hexToBytes, verifyBytes } from "@pokapali/crypto";
import { signParticipant } from "./identity.js";
import { createFeed } from "./sources.js";
import type { WritableFeed } from "./sources.js";

// ── clientIdentities Y.Map tests ────────────────

describe("clientIdentities Y.Map", () => {
  it("empty map initially", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("clientIdentities");
    expect(map.size).toBe(0);
  });

  it("registration stores pubkey and sig", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("clientIdentities");
    map.set("12345", {
      pubkey: "aabbcc",
      sig: "ddeeff",
    });
    expect(map.size).toBe(1);
    const entry = map.get("12345") as {
      pubkey: string;
      sig: string;
    };
    expect(entry.pubkey).toBe("aabbcc");
    expect(entry.sig).toBe("ddeeff");
  });

  it("multiple sessions create distinct entries", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("clientIdentities");
    map.set("100", {
      pubkey: "pub-a",
      sig: "sig-a",
    });
    map.set("200", {
      pubkey: "pub-a",
      sig: "sig-a",
    });
    map.set("300", {
      pubkey: "pub-b",
      sig: "sig-b",
    });
    expect(map.size).toBe(3);
  });

  it("concurrent registrations from " + "different peers merge", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap("clientIdentities");
    const map2 = doc2.getMap("clientIdentities");

    map1.set("100", {
      pubkey: "pub-a",
      sig: "sig-a",
    });
    map2.set("200", {
      pubkey: "pub-b",
      sig: "sig-b",
    });

    // Merge
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    expect(map1.size).toBe(2);
    expect((map1.get("100") as { pubkey: string }).pubkey).toBe("pub-a");
    expect((map1.get("200") as { pubkey: string }).pubkey).toBe("pub-b");
  });

  it("same clientID from two peers: LWW", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    // Sync initial state
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const map1 = doc1.getMap("clientIdentities");
    const map2 = doc2.getMap("clientIdentities");

    map1.set("100", {
      pubkey: "pub-a",
      sig: "sig-a",
    });
    map2.set("100", {
      pubkey: "pub-b",
      sig: "sig-b",
    });

    // After merge, one wins (LWW)
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    const entry = map1.get("100") as {
      pubkey: string;
    };
    expect(entry.pubkey === "pub-a" || entry.pubkey === "pub-b").toBe(true);
  });

  it("persists through Y.Doc encode/decode", () => {
    const doc1 = new Y.Doc();
    const map1 = doc1.getMap("clientIdentities");
    map1.set("42", {
      pubkey: "abc123",
      sig: "def456",
    });

    // Encode and decode into new doc
    const update = Y.encodeStateAsUpdate(doc1);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    const map2 = doc2.getMap("clientIdentities");
    expect(map2.size).toBe(1);
    const entry = map2.get("42") as {
      pubkey: string;
      sig: string;
    };
    expect(entry.pubkey).toBe("abc123");
    expect(entry.sig).toBe("def456");
  });
});

// ── Signature verification tests ────────────────

describe("clientIdentity signature verification", () => {
  it("valid signature verifies", async () => {
    // Use real crypto to produce a valid sig
    const { ed25519KeyPairFromSeed } = await import("@pokapali/crypto");
    const seed = new Uint8Array(32);
    seed[0] = 1;
    const kp = await ed25519KeyPairFromSeed(seed);
    const docId = "test-doc-123";

    const sigHex = await signParticipant(kp, docId);
    const pubkeyHex = bytesToHex(kp.publicKey);

    // Verify using the same format the Feed uses
    const payload = new TextEncoder().encode(pubkeyHex + ":" + docId);
    const ok = await verifyBytes(kp.publicKey, hexToBytes(sigHex), payload);
    expect(ok).toBe(true);
  });

  it("wrong docId fails verification", async () => {
    const { ed25519KeyPairFromSeed } = await import("@pokapali/crypto");
    const seed = new Uint8Array(32);
    seed[0] = 2;
    const kp = await ed25519KeyPairFromSeed(seed);

    const sigHex = await signParticipant(kp, "doc-a");
    const pubkeyHex = bytesToHex(kp.publicKey);

    // Verify against wrong docId
    const payload = new TextEncoder().encode(pubkeyHex + ":" + "doc-b");
    const ok = await verifyBytes(kp.publicKey, hexToBytes(sigHex), payload);
    expect(ok).toBe(false);
  });

  it("wrong pubkey fails verification", async () => {
    const { ed25519KeyPairFromSeed } = await import("@pokapali/crypto");
    const seed1 = new Uint8Array(32);
    seed1[0] = 3;
    const kp1 = await ed25519KeyPairFromSeed(seed1);

    const seed2 = new Uint8Array(32);
    seed2[0] = 4;
    const kp2 = await ed25519KeyPairFromSeed(seed2);

    const docId = "doc-x";
    const sigHex = await signParticipant(kp1, docId);

    // Verify with kp2's pubkey — should fail
    const pubkey2Hex = bytesToHex(kp2.publicKey);
    const payload = new TextEncoder().encode(pubkey2Hex + ":" + docId);
    const ok = await verifyBytes(kp2.publicKey, hexToBytes(sigHex), payload);
    expect(ok).toBe(false);
  });
});

// ── Feed projection tests ───────────────────────

describe("clientIdMapping Feed projection", () => {
  // Simulate the Feed projection logic from
  // create-doc.ts in isolation.
  interface ClientIdentityInfo {
    pubkey: string;
    verified: boolean;
  }

  type IdentityMap = ReadonlyMap<number, ClientIdentityInfo>;

  function createProjection(metaDoc: Y.Doc, ipnsName: string) {
    const EMPTY: IdentityMap = new Map();
    const feed: WritableFeed<IdentityMap> = createFeed<IdentityMap>(EMPTY);

    const verifiedCache = new Map<string, boolean | null>();

    function rebuild(): void {
      const identities = metaDoc.getMap("clientIdentities");
      const result = new Map<number, ClientIdentityInfo>();

      for (const [key, value] of identities.entries()) {
        const clientId = Number(key);
        if (Number.isNaN(clientId)) continue;
        const entry = value as {
          pubkey?: string;
          sig?: string;
        };
        if (!entry?.pubkey || !entry?.sig) continue;

        const cached = verifiedCache.get(key);
        if (cached !== undefined && cached !== null) {
          result.set(clientId, {
            pubkey: entry.pubkey,
            verified: cached,
          });
        } else {
          result.set(clientId, {
            pubkey: entry.pubkey,
            verified: false,
          });
          if (cached === undefined) {
            verifiedCache.set(key, null);
            const payload = new TextEncoder().encode(
              entry.pubkey + ":" + ipnsName,
            );
            verifyBytes(
              hexToBytes(entry.pubkey),
              hexToBytes(entry.sig),
              payload,
            )
              .then((ok) => {
                verifiedCache.set(key, ok);
                rebuild();
              })
              .catch(() => {
                verifiedCache.set(key, false);
                rebuild();
              });
          }
        }
      }

      feed._update(result);
    }

    const identitiesMap = metaDoc.getMap("clientIdentities");
    identitiesMap.observe(rebuild);
    rebuild();

    return { feed, rebuild };
  }

  it("starts empty", () => {
    const doc = new Y.Doc();
    const { feed } = createProjection(doc, "test-doc");
    expect(feed.getSnapshot().size).toBe(0);
  });

  it("reflects a registration", async () => {
    const doc = new Y.Doc();
    const { feed } = createProjection(doc, "test-doc");

    doc.getMap("clientIdentities").set("42", {
      pubkey: "aabb",
      sig: "ccdd",
    });

    const snap = feed.getSnapshot();
    expect(snap.size).toBe(1);
    expect(snap.get(42)?.pubkey).toBe("aabb");
    // Initially unverified (async verification
    // pending)
    expect(snap.get(42)?.verified).toBe(false);
  });

  it("verifies valid sig asynchronously", async () => {
    const { ed25519KeyPairFromSeed } = await import("@pokapali/crypto");
    const seed = new Uint8Array(32);
    seed[0] = 10;
    const kp = await ed25519KeyPairFromSeed(seed);
    const docId = "verify-doc";
    const sigHex = await signParticipant(kp, docId);
    const pubkeyHex = bytesToHex(kp.publicKey);

    const doc = new Y.Doc();
    const { feed } = createProjection(doc, docId);

    doc.getMap("clientIdentities").set("99", {
      pubkey: pubkeyHex,
      sig: sigHex,
    });

    // Wait for async verification
    await vi.waitFor(() => {
      const snap = feed.getSnapshot();
      expect(snap.get(99)?.verified).toBe(true);
    });
  });

  it("notifies subscribers on change", () => {
    const doc = new Y.Doc();
    const { feed } = createProjection(doc, "test-doc");

    const cb = vi.fn();
    feed.subscribe(cb);

    doc.getMap("clientIdentities").set("77", {
      pubkey: "aabb",
      sig: "ccdd",
    });

    expect(cb).toHaveBeenCalled();
  });

  it("skips entries with missing pubkey", () => {
    const doc = new Y.Doc();
    const { feed } = createProjection(doc, "test-doc");

    doc.getMap("clientIdentities").set("50", {
      sig: "ccdd",
    });

    expect(feed.getSnapshot().size).toBe(0);
  });

  it("skips non-numeric clientID keys", () => {
    const doc = new Y.Doc();
    const { feed } = createProjection(doc, "test-doc");

    doc.getMap("clientIdentities").set("not-a-number", {
      pubkey: "aabb",
      sig: "ccdd",
    });

    expect(feed.getSnapshot().size).toBe(0);
  });
});
