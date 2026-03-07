import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { CapabilityKeys } from "@pokapali/capability";
import { parseUrl, inferCapability } from "@pokapali/capability";
import { encodeSnapshot } from "@pokapali/snapshot";

vi.mock("@pokapali/sync", () => ({
  setupNamespaceRooms: vi.fn(() => ({
    status: "connected",
    destroy: vi.fn(),
  })),
  setupAwarenessRoom: vi.fn(() => ({
    awareness: {
      on: vi.fn(),
      off: vi.fn(),
      setLocalStateField: vi.fn(),
      states: new Map(),
    },
    destroy: vi.fn(),
  })),
}));

vi.mock("@pokapali/snapshot", async () => {
  const actual =
    await vi.importActual<typeof import("@pokapali/snapshot")>(
      "@pokapali/snapshot",
    );
  return {
    ...actual,
    encodeSnapshot: vi.fn(actual.encodeSnapshot),
  };
});

import { createCollabLib, type CollabDoc, type DocStatus } from "./index.js";

const OPTS = {
  appId: "test-app",
  namespaces: ["content", "comments"],
  base: "https://example.com",
};

describe("@pokapali/core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() returns CollabDoc", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    expect(doc.subdoc).toBeTypeOf("function");
    expect(doc.provider).toBeDefined();
    expect(doc.awareness).toBeDefined();
    expect(doc.capability).toBeDefined();
    expect(doc.adminUrl).toBeTypeOf("string");
    expect(doc.writeUrl).toBeTypeOf("string");
    expect(doc.readUrl).toBeTypeOf("string");
    expect(doc.inviteUrl).toBeTypeOf("function");
    expect(doc.pushSnapshot).toBeTypeOf("function");
    expect(doc.on).toBeTypeOf("function");
    expect(doc.off).toBeTypeOf("function");
    expect(doc.destroy).toBeTypeOf("function");
    doc.destroy();
  });

  it("create() subdoc(ns) returns Y.Doc", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    const content = doc.subdoc("content");
    const comments = doc.subdoc("comments");
    expect(content).toBeInstanceOf(Y.Doc);
    expect(comments).toBeInstanceOf(Y.Doc);
    doc.destroy();
  });

  it("create() subdoc(unknown) throws", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    expect(() => doc.subdoc("nonexistent")).toThrow(
      /Unknown namespace "nonexistent"/,
    );
    expect(() => doc.subdoc("nonexistent")).toThrow(/content, comments/);
    doc.destroy();
  });

  it("create() capability is admin", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    expect(doc.capability.isAdmin).toBe(true);
    expect(doc.capability.canPushSnapshots).toBe(true);
    expect(doc.capability.namespaces).toEqual(new Set(["content", "comments"]));
    doc.destroy();
  });

  it("create() provider.awareness exists", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    expect(doc.provider.awareness).toBeDefined();
    expect(doc.awareness).toBe(doc.provider.awareness);
    doc.destroy();
  });

  it("create() URLs are pre-computed strings", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    expect(doc.adminUrl).toBeTypeOf("string");
    expect(doc.writeUrl).toBeTypeOf("string");
    expect(doc.readUrl).toBeTypeOf("string");
    expect(doc.adminUrl).not.toBeNull();
    expect(doc.writeUrl).not.toBeNull();
    expect(doc.adminUrl).toContain("https://example.com/doc/");
    expect(doc.readUrl).toContain("https://example.com/doc/");
    doc.destroy();
  });

  it("open(url) infers reader capability", async () => {
    const lib = createCollabLib(OPTS);
    const admin = await lib.create();
    const readUrl = admin.readUrl;
    admin.destroy();

    const reader = await lib.open(readUrl);
    expect(reader.capability.isAdmin).toBe(false);
    expect(reader.capability.canPushSnapshots).toBe(false);
    expect(reader.capability.namespaces.size).toBe(0);
    expect(reader.adminUrl).toBeNull();
    expect(reader.writeUrl).toBeNull();
    reader.destroy();
  });

  it("pushSnapshot() increments seq", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();

    spy.mockClear();
    await doc.pushSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
    // seq = 1, prev = null
    expect(spy.mock.calls[0][3]).toBe(1);
    expect(spy.mock.calls[0][2]).toBeNull();

    await doc.pushSnapshot();
    expect(spy).toHaveBeenCalledTimes(2);
    // seq = 2, prev = CID
    expect(spy.mock.calls[1][3]).toBe(2);
    expect(spy.mock.calls[1][2]).not.toBeNull();
    doc.destroy();
  });

  it("pushSnapshot() no-op for readers", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = createCollabLib(OPTS);
    const admin = await lib.create();
    const readUrl = admin.readUrl;
    admin.destroy();

    spy.mockClear();
    const reader = await lib.open(readUrl);
    await reader.pushSnapshot();
    expect(spy).not.toHaveBeenCalled();
    reader.destroy();
  });

  it("inviteUrl returns narrowed URL", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    const url = await doc.inviteUrl({
      namespaces: ["comments"],
    });
    expect(url).toContain("https://example.com/doc/");

    const parsed = await parseUrl(url);
    const cap = inferCapability(parsed.keys, OPTS.namespaces);
    expect(cap.namespaces).toEqual(new Set(["comments"]));
    expect(cap.canPushSnapshots).toBe(false);
    expect(cap.isAdmin).toBe(false);
    doc.destroy();
  });

  it("inviteUrl throws on escalation", async () => {
    const lib = createCollabLib(OPTS);
    const admin = await lib.create();
    const readUrl = admin.readUrl;
    admin.destroy();

    const reader = await lib.open(readUrl);
    await expect(
      reader.inviteUrl({
        canPushSnapshots: true,
      }),
    ).rejects.toThrow(/Cannot grant canPushSnapshots/);
    reader.destroy();
  });

  it("status reflects sync + dirty", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();

    // After create(), _meta writes trigger
    // dirty. Push to clear.
    await doc.pushSnapshot();
    expect(doc.status).toBe("synced");

    // Edit a subdoc to trigger dirty
    const content = doc.subdoc("content");
    content.getMap("test").set("key", "value");
    expect(doc.status).toBe("unpushed-changes");
    doc.destroy();
  });

  it("on('status') fires on change", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();

    // Push snapshot to clear dirty state
    await doc.pushSnapshot();
    expect(doc.status).toBe("synced");

    const statuses: DocStatus[] = [];
    doc.on("status", (s: DocStatus) => {
      statuses.push(s);
    });

    // Edit to trigger dirty → status change
    const content = doc.subdoc("content");
    content.getMap("test").set("k", "v");
    expect(statuses).toContain("unpushed-changes");
    doc.destroy();
  });

  it("on('snapshot-recommended') fires", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    await doc.pushSnapshot();

    let fired = false;
    doc.on("snapshot-recommended", () => {
      fired = true;
    });

    const content = doc.subdoc("content");
    content.getMap("test").set("k", "v");
    expect(fired).toBe(true);
    doc.destroy();
  });

  it("destroy() is idempotent", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    doc.destroy();
    doc.destroy(); // no error
  });

  it("destroy() prevents further use", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    doc.destroy();
    expect(() => doc.subdoc("content")).toThrow(/destroyed/);
  });

  it("_meta populated on create", async () => {
    const lib = createCollabLib(OPTS);
    const doc = await lib.create();
    const meta = doc.subdoc("_meta");

    const canPush = meta.getArray("canPushSnapshots");
    expect(canPush.length).toBe(1);
    expect(canPush.get(0)).toBeInstanceOf(Uint8Array);

    const authorized = meta.getMap("authorized");
    for (const ns of OPTS.namespaces) {
      const arr = authorized.get(ns);
      expect(arr).toBeInstanceOf(Y.Array);
      expect((arr as Y.Array<unknown>).length).toBe(1);
    }
    doc.destroy();
  });

  describe("history()", () => {
    it("returns empty before any pushSnapshot", async () => {
      const lib = createCollabLib(OPTS);
      const doc = await lib.create();
      const h = await doc.history();
      expect(h).toEqual([]);
      doc.destroy();
    });

    it("returns entries after pushSnapshot", async () => {
      const lib = createCollabLib(OPTS);
      const doc = await lib.create();

      await doc.pushSnapshot();
      const h = await doc.history();
      expect(h).toHaveLength(1);
      expect(h[0].seq).toBe(1);
      expect(h[0].ts).toBeTypeOf("number");
      expect(h[0].cid).toBeDefined();
      doc.destroy();
    });

    it("walks chain newest-first", async () => {
      const lib = createCollabLib(OPTS);
      const doc = await lib.create();

      await doc.pushSnapshot();
      const content = doc.subdoc("content");
      content.getMap("test").set("k", "v");
      await doc.pushSnapshot();

      const h = await doc.history();
      expect(h).toHaveLength(2);
      // newest first
      expect(h[0].seq).toBe(2);
      expect(h[1].seq).toBe(1);
      // CIDs differ
      expect(h[0].cid.toString()).not.toBe(h[1].cid.toString());
      doc.destroy();
    });
  });

  describe("loadVersion()", () => {
    it("returns Y.Doc instances with content", async () => {
      const lib = createCollabLib(OPTS);
      const doc = await lib.create();

      const content = doc.subdoc("content");
      content.getMap("data").set("hello", "world");
      await doc.pushSnapshot();

      const h = await doc.history();
      const version = await doc.loadVersion(h[0].cid);
      expect(version).toBeDefined();
      expect(version["content"]).toBeInstanceOf(Y.Doc);
      const restored = version["content"].getMap("data").get("hello");
      expect(restored).toBe("world");
      doc.destroy();
    });

    it("throws for unknown CID", async () => {
      const { CID } = await import("multiformats/cid");
      const { sha256 } = await import("multiformats/hashes/sha2");
      const lib = createCollabLib(OPTS);
      const doc = await lib.create();

      const hash = await sha256.digest(new Uint8Array([1, 2, 3]));
      const fakeCid = CID.createV1(0x71, hash);
      await expect(doc.loadVersion(fakeCid)).rejects.toThrow(/Unknown CID/);
      doc.destroy();
    });
  });
});
