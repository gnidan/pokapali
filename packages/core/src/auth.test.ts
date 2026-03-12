/**
 * Tests for publisher authorization:
 * - authorize()/deauthorize() Y.Map operations
 * - isPublisherAuthorized logic
 * - interpreter skips unauthorized publishers
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
    emitStatus: vi.fn(),
    emitSaveState: vi.fn(),
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
});
