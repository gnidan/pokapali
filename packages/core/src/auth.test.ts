/**
 * Tests for publisher authorization:
 * - authorize()/deauthorize() Y.Map operations
 * - isPublisherAuthorized logic
 * - interpreter skips unauthorized publishers
 * - state transitions (permissionless → auth)
 * - concurrent Y.Map merges
 * - decode error fallback
 * - legacy snapshots (no publisher field)
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { runInterpreter } from "./interpreter.js";
import type { EffectHandlers } from "./interpreter.js";
import { reduce } from "./reducers.js";
import { initialDocState } from "./facts.js";
import type { Fact, DocState } from "./facts.js";
import { createAsyncQueue, merge, scan } from "./sources.js";

// ── authorize/deauthorize tests ─────────────────

describe("authorizedPublishers Y.Map", () => {
  it("empty map = permissionless", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    expect(map.size).toBe(0);
  });

  it("authorize adds pubkey", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("abc123", true);
    expect(map.has("abc123")).toBe(true);
    expect(map.size).toBe(1);
  });

  it("deauthorize removes pubkey", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("abc123", true);
    map.set("def456", true);
    map.delete("abc123");
    expect(map.has("abc123")).toBe(false);
    expect(map.has("def456")).toBe(true);
    expect(map.size).toBe(1);
  });

  it("concurrent authorize deduplicates", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const map1 = doc1.getMap<true>("authorizedPublishers");
    const map2 = doc2.getMap<true>("authorizedPublishers");
    map1.set("abc123", true);
    map2.set("abc123", true);
    // Merge
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    expect(map1.size).toBe(1);
    expect(map1.has("abc123")).toBe(true);
  });

  it("multiple publishers authorized", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("pub-a", true);
    map.set("pub-b", true);
    map.set("pub-c", true);
    expect(map.size).toBe(3);
    expect(map.has("pub-a")).toBe(true);
    expect(map.has("pub-b")).toBe(true);
    expect(map.has("pub-c")).toBe(true);
  });

  it(
    "concurrent authorize + deauthorize " + "converges via last-writer-wins",
    () => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      // Sync initial state
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      const map1 = doc1.getMap<true>("authorizedPublishers");
      const map2 = doc2.getMap<true>("authorizedPublishers");

      // doc1 authorizes, doc2 also authorizes
      // then doc1 deauthorizes
      map1.set("pub-x", true);
      map2.set("pub-x", true);
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
      map1.delete("pub-x");

      // After merge, doc2 should see the delete
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
      expect(map2.has("pub-x")).toBe(false);
    },
  );

  it("concurrent different publishers " + "merge to union", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const map1 = doc1.getMap<true>("authorizedPublishers");
    const map2 = doc2.getMap<true>("authorizedPublishers");

    map1.set("pub-a", true);
    map2.set("pub-b", true);

    // Merge both ways
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    expect(map1.size).toBe(2);
    expect(map1.has("pub-a")).toBe(true);
    expect(map1.has("pub-b")).toBe(true);
    expect(map2.size).toBe(2);
  });
});

// ── isPublisherAuthorized logic ─────────────────

describe("isPublisherAuthorized logic", () => {
  function isAuthorized(
    map: Y.Map<true>,
    publisherHex: string | undefined,
  ): boolean {
    if (map.size === 0) return true;
    if (!publisherHex) return false;
    return map.has(publisherHex);
  }

  it("permissionless: accepts any publisher", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    expect(isAuthorized(map, "abc")).toBe(true);
    expect(isAuthorized(map, undefined)).toBe(true);
  });

  it("auth enabled: accepts listed publisher", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("abc123", true);
    expect(isAuthorized(map, "abc123")).toBe(true);
  });

  it("auth enabled: rejects unlisted", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("abc123", true);
    expect(isAuthorized(map, "xyz789")).toBe(false);
  });

  it("auth enabled: rejects missing publisher", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("abc123", true);
    expect(isAuthorized(map, undefined)).toBe(false);
  });

  it("permissionless → auth: adding first " + "publisher switches mode", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");

    // Permissionless: anyone accepted
    expect(isAuthorized(map, "stranger")).toBe(true);
    expect(isAuthorized(map, undefined)).toBe(true);

    // Add first publisher → auth enabled
    map.set("admin-pub", true);
    expect(isAuthorized(map, "admin-pub")).toBe(true);
    expect(isAuthorized(map, "stranger")).toBe(false);
    expect(isAuthorized(map, undefined)).toBe(false);
  });

  it(
    "auth → permissionless: removing last " +
      "publisher reverts to permissionless",
    () => {
      const doc = new Y.Doc();
      const map = doc.getMap<true>("authorizedPublishers");

      map.set("only-pub", true);
      expect(isAuthorized(map, "stranger")).toBe(false);

      // Remove the only publisher → permissionless
      map.delete("only-pub");
      expect(isAuthorized(map, "stranger")).toBe(true);
      expect(isAuthorized(map, undefined)).toBe(true);
    },
  );

  it("auth with multiple: accepts all listed", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("pub-a", true);
    map.set("pub-b", true);
    map.set("pub-c", true);
    expect(isAuthorized(map, "pub-a")).toBe(true);
    expect(isAuthorized(map, "pub-b")).toBe(true);
    expect(isAuthorized(map, "pub-c")).toBe(true);
    expect(isAuthorized(map, "pub-d")).toBe(false);
  });

  it("empty string publisher rejected " + "when auth enabled", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");
    map.set("real-pub", true);
    expect(isAuthorized(map, "")).toBe(false);
  });

  it(
    "self-deauthorization: admin removes " +
      "own pubkey → no longer authorized",
    () => {
      const doc = new Y.Doc();
      const map = doc.getMap<true>("authorizedPublishers");

      // Admin authorizes self
      map.set("admin-pub", true);
      expect(isAuthorized(map, "admin-pub")).toBe(true);

      // Admin removes self
      map.delete("admin-pub");
      // Now permissionless (map empty)
      expect(isAuthorized(map, "admin-pub")).toBe(true);
      expect(isAuthorized(map, "stranger")).toBe(true);
    },
  );

  it(
    "self-deauthorization with other " +
      "publishers: admin removed but " +
      "others remain",
    () => {
      const doc = new Y.Doc();
      const map = doc.getMap<true>("authorizedPublishers");

      map.set("admin-pub", true);
      map.set("other-pub", true);
      expect(isAuthorized(map, "admin-pub")).toBe(true);

      // Admin removes only self
      map.delete("admin-pub");
      // Auth still enabled (other-pub remains)
      expect(isAuthorized(map, "admin-pub")).toBe(false);
      expect(isAuthorized(map, "other-pub")).toBe(true);
    },
  );

  it("self-deauthorization then re-auth " + "restores access", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<true>("authorizedPublishers");

    map.set("admin-pub", true);
    map.set("other-pub", true);

    // Remove self
    map.delete("admin-pub");
    expect(isAuthorized(map, "admin-pub")).toBe(false);

    // Re-authorize self
    map.set("admin-pub", true);
    expect(isAuthorized(map, "admin-pub")).toBe(true);
  });
});

// ── interpreter authorization test ──────────────

async function makeCid(data: string) {
  const bytes = new TextEncoder().encode(data);
  const hash = await sha256.digest(bytes);
  return CID.createV1(0x71, hash);
}

function mockEffects(overrides?: Partial<EffectHandlers>): EffectHandlers {
  return {
    fetchBlock: vi.fn().mockResolvedValue(null),
    applySnapshot: vi.fn().mockResolvedValue({
      seq: 1,
    }),
    getBlock: vi.fn().mockReturnValue(null),
    decodeBlock: vi.fn().mockReturnValue({}),
    isPublisherAuthorized: vi.fn().mockReturnValue(true),
    announce: vi.fn(),
    markReady: vi.fn(),
    emitSnapshotApplied: vi.fn(),
    emitAck: vi.fn(),
    emitGossipActivity: vi.fn(),
    emitLoading: vi.fn(),
    emitGuarantee: vi.fn(),
    emitValidationError: vi.fn(),
    ...overrides,
  };
}

describe("interpreter publisher authorization", () => {
  it("skips apply for unauthorized publisher", async () => {
    const cid = await makeCid("unauth-block");
    const block = new Uint8Array([1, 2, 3]);

    const init = initialDocState({
      ipnsName: "test",
      role: "reader",
      channels: ["content"],
      appId: "test",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const applyMock = vi.fn().mockResolvedValue({ seq: 1 });

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      applySnapshot: applyMock,
      getBlock: vi.fn().mockReturnValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
        publisher: "unauthorized-pub",
      }),
      isPublisherAuthorized: vi.fn(
        (pub: string | undefined) => pub !== "unauthorized-pub",
      ),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // Discover CID with inline block
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid,
      source: "gossipsub",
      block,
      seq: 1,
    });

    // Let interpreter process
    await new Promise((r) => setTimeout(r, 100));

    // applySnapshot should NOT be called
    expect(applyMock).not.toHaveBeenCalled();
    expect(effects.isPublisherAuthorized).toHaveBeenCalledWith(
      "unauthorized-pub",
    );

    ac.abort();
    await done.catch(() => {});
  });

  it(
    "legacy snapshot (no publisher) accepted " + "in permissionless mode",
    async () => {
      const cid = await makeCid("legacy-block");
      const block = new Uint8Array([10, 11, 12]);

      const init = initialDocState({
        ipnsName: "legacy-test",
        role: "reader",
        channels: ["content"],
        appId: "legacy",
      });

      const ac = new AbortController();
      const input = createAsyncQueue<Fact>(ac.signal);
      const feedback = createAsyncQueue<Fact>(ac.signal);

      const applyMock = vi.fn().mockResolvedValue({
        seq: 1,
      });

      const effects = mockEffects({
        fetchBlock: vi.fn().mockResolvedValue(block),
        applySnapshot: applyMock,
        getBlock: vi.fn().mockReturnValue(block),
        // No publisher field — legacy snapshot
        decodeBlock: vi.fn().mockReturnValue({
          seq: 1,
        }),
        // Permissionless: map.size === 0
        isPublisherAuthorized: vi.fn(() => true),
      });

      const stateStream = scan(merge(input, feedback), reduce, init);

      async function* capture(
        stream: AsyncIterable<{
          prev: DocState;
          next: DocState;
          fact: Fact;
        }>,
      ) {
        yield* stream;
      }

      const done = runInterpreter(
        capture(stateStream),
        effects,
        feedback,
        ac.signal,
      );

      input.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "gossipsub",
        block,
        seq: 1,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Legacy snapshot accepted in permissionless
      expect(applyMock).toHaveBeenCalledWith(cid, block);
      // isPublisherAuthorized called with
      // undefined (no publisher field)
      expect(effects.isPublisherAuthorized).toHaveBeenCalledWith(undefined);

      ac.abort();
      await done.catch(() => {});
    },
  );

  it(
    "legacy snapshot (no publisher) rejected " + "when auth enabled",
    async () => {
      const cid = await makeCid("legacy-rejected");
      const block = new Uint8Array([13, 14, 15]);

      const init = initialDocState({
        ipnsName: "legacy-auth",
        role: "reader",
        channels: ["content"],
        appId: "legacy-auth",
      });

      const ac = new AbortController();
      const input = createAsyncQueue<Fact>(ac.signal);
      const feedback = createAsyncQueue<Fact>(ac.signal);

      const applyMock = vi.fn().mockResolvedValue({
        seq: 1,
      });

      const effects = mockEffects({
        fetchBlock: vi.fn().mockResolvedValue(block),
        applySnapshot: applyMock,
        getBlock: vi.fn().mockReturnValue(block),
        // Legacy: no publisher
        decodeBlock: vi.fn().mockReturnValue({
          seq: 1,
        }),
        // Auth enabled: rejects undefined publisher
        isPublisherAuthorized: vi.fn(
          (pub: string | undefined) => pub !== undefined,
        ),
      });

      const stateStream = scan(merge(input, feedback), reduce, init);

      async function* capture(
        stream: AsyncIterable<{
          prev: DocState;
          next: DocState;
          fact: Fact;
        }>,
      ) {
        yield* stream;
      }

      const done = runInterpreter(
        capture(stateStream),
        effects,
        feedback,
        ac.signal,
      );

      input.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "gossipsub",
        block,
        seq: 1,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Legacy snapshot rejected when auth enabled
      expect(applyMock).not.toHaveBeenCalled();

      ac.abort();
      await done.catch(() => {});
    },
  );

  it(
    "decode error returns empty object — " + "treated as permissionless",
    async () => {
      const cid = await makeCid("malformed-block");
      const block = new Uint8Array([0xff, 0xfe]);

      const init = initialDocState({
        ipnsName: "decode-err",
        role: "reader",
        channels: ["content"],
        appId: "decode-err",
      });

      const ac = new AbortController();
      const input = createAsyncQueue<Fact>(ac.signal);
      const feedback = createAsyncQueue<Fact>(ac.signal);

      const applyMock = vi.fn().mockResolvedValue({
        seq: 1,
      });

      const effects = mockEffects({
        fetchBlock: vi.fn().mockResolvedValue(block),
        applySnapshot: applyMock,
        getBlock: vi.fn().mockReturnValue(block),
        // decodeBlock returns {} on error
        decodeBlock: vi.fn().mockReturnValue({}),
        // Permissionless: accepts undefined
        isPublisherAuthorized: vi.fn(() => true),
      });

      const stateStream = scan(merge(input, feedback), reduce, init);

      async function* capture(
        stream: AsyncIterable<{
          prev: DocState;
          next: DocState;
          fact: Fact;
        }>,
      ) {
        yield* stream;
      }

      const done = runInterpreter(
        capture(stateStream),
        effects,
        feedback,
        ac.signal,
      );

      input.push({
        type: "cid-discovered",
        ts: Date.now(),
        cid,
        source: "gossipsub",
        block,
        seq: 1,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Decode error → publisher=undefined →
      // permissionless accepts
      expect(effects.isPublisherAuthorized).toHaveBeenCalledWith(undefined);
      expect(applyMock).toHaveBeenCalled();

      ac.abort();
      await done.catch(() => {});
    },
  );

  it("applies snapshot for authorized publisher", async () => {
    const cid = await makeCid("auth-block");
    const block = new Uint8Array([4, 5, 6]);

    const init = initialDocState({
      ipnsName: "test2",
      role: "reader",
      channels: ["content"],
      appId: "test2",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const applyMock = vi.fn().mockResolvedValue({ seq: 1 });

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      applySnapshot: applyMock,
      getBlock: vi.fn().mockReturnValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
        publisher: "good-pub",
      }),
      isPublisherAuthorized: vi.fn().mockReturnValue(true),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // Discover CID with inline block
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid,
      source: "gossipsub",
      block,
      seq: 1,
    });

    // Let interpreter process
    await new Promise((r) => setTimeout(r, 100));

    // applySnapshot should be called
    expect(applyMock).toHaveBeenCalledWith(cid, block);

    ac.abort();
    await done.catch(() => {});
  });

  it("dynamic auth: policy changes between " + "blocks", async () => {
    const cid1 = await makeCid("block-1");
    const cid2 = await makeCid("block-2");
    const block1 = new Uint8Array([1, 2, 3]);
    const block2 = new Uint8Array([4, 5, 6]);

    const init = initialDocState({
      ipnsName: "dynamic-auth",
      role: "reader",
      channels: ["content"],
      appId: "dynamic",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const applyMock = vi.fn().mockResolvedValue({
      seq: 1,
    });

    // Auth policy: starts accepting pub-a,
    // then changes to reject it
    let authorized = new Set(["pub-a"]);
    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(null),
      applySnapshot: applyMock,
      getBlock: vi.fn((cid: CID) => {
        if (cid.equals(cid1)) return block1;
        if (cid.equals(cid2)) return block2;
        return null;
      }),
      decodeBlock: vi.fn((block: Uint8Array) => {
        if (block === block1) {
          return { seq: 1, publisher: "pub-a" };
        }
        return { seq: 2, publisher: "pub-a" };
      }),
      isPublisherAuthorized: vi.fn(
        (pub: string | undefined) => pub != null && authorized.has(pub),
      ),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // First block: pub-a authorized
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid: cid1,
      source: "gossipsub",
      block: block1,
      seq: 1,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(applyMock).toHaveBeenCalledTimes(1);

    // Change policy: revoke pub-a
    authorized = new Set<string>();

    // Second block: pub-a no longer authorized
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid: cid2,
      source: "gossipsub",
      block: block2,
      seq: 2,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Second block should NOT be applied
    expect(applyMock).toHaveBeenCalledTimes(1);

    ac.abort();
    await done.catch(() => {});
  });

  it("multiple publishers: only authorized " + "ones applied", async () => {
    const cidGood = await makeCid("good-pub");
    const cidBad = await makeCid("bad-pub");
    const blockGood = new Uint8Array([10, 20]);
    const blockBad = new Uint8Array([30, 40]);

    const init = initialDocState({
      ipnsName: "multi-pub",
      role: "reader",
      channels: ["content"],
      appId: "multi",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const applyMock = vi.fn().mockResolvedValue({
      seq: 1,
    });

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(null),
      applySnapshot: applyMock,
      getBlock: vi.fn((cid: CID) => {
        if (cid.equals(cidGood)) return blockGood;
        if (cid.equals(cidBad)) return blockBad;
        return null;
      }),
      decodeBlock: vi.fn((block: Uint8Array) => {
        if (block === blockGood) {
          return {
            seq: 2,
            publisher: "allowed-pub",
          };
        }
        return {
          seq: 1,
          publisher: "denied-pub",
        };
      }),
      isPublisherAuthorized: vi.fn(
        (pub: string | undefined) => pub === "allowed-pub",
      ),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // Discover both blocks — denied first,
    // then authorized (higher seq)
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid: cidBad,
      source: "gossipsub",
      block: blockBad,
      seq: 1,
    });
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid: cidGood,
      source: "gossipsub",
      block: blockGood,
      seq: 2,
    });

    await new Promise((r) => setTimeout(r, 150));

    // Only the authorized block applied
    expect(applyMock).toHaveBeenCalledWith(cidGood, blockGood);
    // denied block NOT applied
    for (const call of applyMock.mock.calls) {
      expect(call[0].toString()).not.toBe(cidBad.toString());
    }

    ac.abort();
    await done.catch(() => {});
  });
});

// ── interpreter http-tip integration ────────────

describe("interpreter http-tip source", () => {
  it("http-tip cid-discovered triggers " + "auto-fetch and apply", async () => {
    const cid = await makeCid("http-tip-block");
    const block = new Uint8Array([7, 8, 9]);

    const init = initialDocState({
      ipnsName: "http-tip-test",
      role: "reader",
      channels: ["content"],
      appId: "http-tip",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const applyMock = vi.fn().mockResolvedValue({ seq: 1 });

    const effects = mockEffects({
      fetchBlock: vi.fn().mockResolvedValue(block),
      applySnapshot: applyMock,
      getBlock: vi.fn().mockReturnValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
      }),
      isPublisherAuthorized: vi.fn().mockReturnValue(true),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // Discover CID via http-tip source
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid,
      source: "http-tip",
      block,
      seq: 1,
    });

    await new Promise((r) => setTimeout(r, 100));

    // http-tip should trigger apply
    expect(applyMock).toHaveBeenCalledWith(cid, block);

    ac.abort();
    await done.catch(() => {});
  });

  it("http-tip with inline block skips " + "fetchBlock", async () => {
    const cid = await makeCid("inline-http");
    const block = new Uint8Array([10, 11, 12]);

    const init = initialDocState({
      ipnsName: "inline-test",
      role: "reader",
      channels: ["content"],
      appId: "inline",
    });

    const ac = new AbortController();
    const input = createAsyncQueue<Fact>(ac.signal);
    const feedback = createAsyncQueue<Fact>(ac.signal);

    const fetchMock = vi.fn().mockResolvedValue(null);
    const applyMock = vi.fn().mockResolvedValue({ seq: 1 });

    const effects = mockEffects({
      fetchBlock: fetchMock,
      applySnapshot: applyMock,
      getBlock: vi.fn().mockReturnValue(block),
      decodeBlock: vi.fn().mockReturnValue({
        seq: 1,
      }),
      isPublisherAuthorized: vi.fn().mockReturnValue(true),
    });

    const stateStream = scan(merge(input, feedback), reduce, init);

    async function* capture(
      stream: AsyncIterable<{
        prev: DocState;
        next: DocState;
        fact: Fact;
      }>,
    ) {
      yield* stream;
    }

    const done = runInterpreter(
      capture(stateStream),
      effects,
      feedback,
      ac.signal,
    );

    // http-tip with inline block
    input.push({
      type: "cid-discovered",
      ts: Date.now(),
      cid,
      source: "http-tip",
      block,
      seq: 1,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Block was inline → should NOT call fetchBlock
    expect(fetchMock).not.toHaveBeenCalled();
    // But should still apply
    expect(applyMock).toHaveBeenCalledWith(cid, block);

    ac.abort();
    await done.catch(() => {});
  });
});
