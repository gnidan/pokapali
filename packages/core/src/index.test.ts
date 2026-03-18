import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { parseUrl, inferCapability } from "@pokapali/capability";
import { encodeSnapshot } from "@pokapali/snapshot";
import { setLogLevel, getLogLevel } from "@pokapali/log";
import {
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";

vi.mock("./helia.js", () => ({
  acquireHelia: vi.fn(async () => ({})),
  releaseHelia: vi.fn(async () => {}),
  getHeliaPubsub: vi.fn(() => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSubscribers: vi.fn(() => []),
    getTopics: vi.fn(() => []),
  })),
  getHelia: vi.fn(() => ({
    blockstore: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("Not found")),
    },
    libp2p: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })),
  isHeliaLive: vi.fn(() => false),
}));

vi.mock("./ipns-helpers.js", () => ({
  publishIPNS: vi.fn().mockResolvedValue(undefined),
  resolveIPNS: vi.fn().mockResolvedValue(null),
  watchIPNS: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("./announce.js", () => ({
  announceSnapshot: vi.fn().mockResolvedValue(undefined),
  announceTopic: vi.fn().mockReturnValue("/pokapali/app/test/announce"),
  parseAnnouncement: vi.fn().mockReturnValue(null),
  parseGuaranteeResponse: vi.fn().mockReturnValue(null),
  publishGuaranteeQuery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./peer-discovery.js", () => ({
  startRoomDiscovery: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

vi.mock("./node-registry.js", () => ({
  acquireNodeRegistry: vi.fn(),
  getNodeRegistry: vi.fn(() => null),
  NODE_CAPS_TOPIC: "pokapali._node-caps._p2p._pubsub",
}));

vi.mock("@pokapali/sync", () => ({
  setupNamespaceRooms: vi.fn(() => ({
    status: "connected",
    onStatusChange: vi.fn(),
    connectChannel: vi.fn(),
    destroy: vi.fn(),
  })),
  setupAwarenessRoom: vi.fn(() => ({
    awareness: {
      on: vi.fn(),
      off: vi.fn(),
      setLocalStateField: vi.fn(),
      states: new Map(),
    },
    connected: true,
    onStatusChange: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock("blockstore-idb", () => ({
  IDBBlockstore: vi.fn(() => ({
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./persistence.js", () => ({
  createDocPersistence: vi.fn(() => ({
    whenSynced: Promise.resolve(),
    providers: new Set(),
    destroy: vi.fn(),
  })),
}));

vi.mock("./identity.js", () => ({
  loadIdentity: vi.fn(async () => ({
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  })),
  signParticipant: vi.fn(async () => "aa".repeat(32)),
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

import {
  pokapali,
  type Doc,
  type SaveState,
  type Diagnostics,
} from "./index.js";
import { acquireNodeRegistry, getNodeRegistry } from "./node-registry.js";
import { publishGuaranteeQuery } from "./announce.js";

const OPTS = {
  appId: "test-app",
  channels: ["content", "comments"],
  origin: "https://example.com",
};

describe("@pokapali/core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() returns Doc", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.channel).toBeTypeOf("function");
    expect(doc.provider).toBeDefined();
    expect(doc.awareness).toBeDefined();
    expect(doc.capability).toBeDefined();
    expect(doc.urls.admin).toBeTypeOf("string");
    expect(doc.urls.write).toBeTypeOf("string");
    expect(doc.urls.read).toBeTypeOf("string");
    expect(doc.invite).toBeTypeOf("function");
    expect(doc.publish).toBeTypeOf("function");
    expect(doc.on).toBeTypeOf("function");
    expect(doc.off).toBeTypeOf("function");
    expect(doc.destroy).toBeTypeOf("function");
    doc.destroy();
  });

  it("create() channel(name) returns Y.Doc", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    const content = doc.channel("content");
    const comments = doc.channel("comments");
    expect(content).toBeInstanceOf(Y.Doc);
    expect(comments).toBeInstanceOf(Y.Doc);
    doc.destroy();
  });

  it("create() channel(unknown) throws", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(() => doc.channel("nonexistent")).toThrow(
      /Unknown channel "nonexistent"/,
    );
    expect(() => doc.channel("nonexistent")).toThrow(/content, comments/);
    doc.destroy();
  });

  it("create() capability is admin", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.capability.isAdmin).toBe(true);
    expect(doc.capability.canPushSnapshots).toBe(true);
    expect(doc.capability.channels).toEqual(new Set(["content", "comments"]));
    doc.destroy();
  });

  it("create() provider.awareness exists", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.provider.awareness).toBeDefined();
    expect(doc.awareness).toBe(doc.provider.awareness);
    doc.destroy();
  });

  it("create() URLs are pre-computed strings", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.urls.admin).toBeTypeOf("string");
    expect(doc.urls.write).toBeTypeOf("string");
    expect(doc.urls.read).toBeTypeOf("string");
    expect(doc.urls.admin).not.toBeNull();
    expect(doc.urls.write).not.toBeNull();
    expect(doc.urls.admin).toContain("https://example.com/doc/");
    expect(doc.urls.read).toContain("https://example.com/doc/");
    doc.destroy();
  });

  it("open(url) infers reader capability", async () => {
    const lib = pokapali(OPTS);
    const admin = await lib.create();
    const readUrl = admin.urls.read;
    admin.destroy();

    const reader = await lib.open(readUrl);
    expect(reader.capability.isAdmin).toBe(false);
    expect(reader.capability.canPushSnapshots).toBe(false);
    expect(reader.capability.channels.size).toBe(0);
    expect(reader.urls.admin).toBeNull();
    expect(reader.urls.write).toBeNull();
    reader.destroy();
  });

  it("publish() increments seq", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    spy.mockClear();
    await doc.publish();
    expect(spy).toHaveBeenCalledTimes(1);
    // seq = 1, prev = null
    expect(spy.mock.calls[0][3]).toBe(1);
    expect(spy.mock.calls[0][2]).toBeNull();

    await doc.publish();
    expect(spy).toHaveBeenCalledTimes(2);
    // seq = 2, prev = CID
    expect(spy.mock.calls[1][3]).toBe(2);
    expect(spy.mock.calls[1][2]).not.toBeNull();
    doc.destroy();
  });

  it("publish() no-op for readers", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = pokapali(OPTS);
    const admin = await lib.create();
    const readUrl = admin.urls.read;
    admin.destroy();

    spy.mockClear();
    const reader = await lib.open(readUrl);
    await reader.publish();
    expect(spy).not.toHaveBeenCalled();
    reader.destroy();
  });

  it("invite returns narrowed URL", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    const url = await doc.invite({
      channels: ["comments"],
    });
    expect(url).toContain("https://example.com/doc/");

    const parsed = await parseUrl(url);
    const cap = inferCapability(parsed.keys, OPTS.channels);
    expect(cap.channels).toEqual(new Set(["comments"]));
    expect(cap.canPushSnapshots).toBe(false);
    expect(cap.isAdmin).toBe(false);
    doc.destroy();
  });

  it("invite throws on escalation", async () => {
    const lib = pokapali(OPTS);
    const admin = await lib.create();
    const readUrl = admin.urls.read;
    admin.destroy();

    const reader = await lib.open(readUrl);
    await expect(
      reader.invite({
        canPushSnapshots: true,
      }),
    ).rejects.toThrow(/Cannot grant canPushSnapshots/);
    reader.destroy();
  });

  it("configuredChannels lists all channels", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.configuredChannels).toEqual(["content", "comments"]);
    doc.destroy();
  });

  it(
    "writer with subset of channels warns on" + " missing channel access",
    async () => {
      const lib = pokapali(OPTS);
      const admin = await lib.create();
      // Invite writer with only "content" channel
      const url = await admin.invite({
        channels: ["content"],
        canPushSnapshots: true,
      });
      admin.destroy();

      const writer = await lib.open(url);
      expect(writer.capability.channels).toEqual(new Set(["content"]));
      expect(writer.configuredChannels).toEqual(["content", "comments"]);

      // Ensure log level allows warn output
      const prevLevel = getLogLevel();
      setLogLevel("warn");

      // Accessing "content" (has key) should not warn
      const warnSpy = vi.spyOn(console, "warn");
      writer.channel("content");
      const contentWarns = warnSpy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes('Channel "content"'),
        ),
      );
      expect(contentWarns).toHaveLength(0);

      // Accessing "comments" (no key) should warn
      writer.channel("comments");
      const commentsWarns = warnSpy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes('Channel "comments"'),
        ),
      );
      expect(commentsWarns).toHaveLength(1);

      // Second call should NOT warn again (dedup)
      writer.channel("comments");
      const afterSecond = warnSpy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes('Channel "comments"'),
        ),
      );
      expect(afterSecond).toHaveLength(1);

      warnSpy.mockRestore();
      setLogLevel(prevLevel);
      writer.destroy();
    },
  );

  it("admin accessing all channels does not warn", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    const prevLevel = getLogLevel();
    setLogLevel("warn");
    const warnSpy = vi.spyOn(console, "warn");
    doc.channel("content");
    doc.channel("comments");
    const channelWarns = warnSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("write key")),
    );
    expect(channelWarns).toHaveLength(0);
    warnSpy.mockRestore();
    setLogLevel(prevLevel);
    doc.destroy();
  });

  it("admin write URL includes all channels" + " for re-invite", async () => {
    const lib = pokapali(OPTS);
    const admin = await lib.create();
    const writeUrl = admin.urls.write!;
    admin.destroy();

    // Writer opening the admin's write URL should
    // have all channels
    const writer = await lib.open(writeUrl);
    expect(writer.capability.channels).toEqual(
      new Set(["content", "comments"]),
    );
    expect(writer.capability.canPushSnapshots).toBe(true);
    writer.destroy();
  });

  it("status starts as 'connecting' before P2P", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // Before p2pReady resolves, status is
    // "connecting" (sync layer not wired yet).
    expect(doc.status.getSnapshot()).toBe("connecting");
    doc.destroy();
  });

  it("saveState reflects dirty + saving", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // After create(), _meta writes trigger dirty.
    // Push to clear.
    await doc.publish();
    expect(doc.saveState.getSnapshot()).toBe("saved");

    // Edit a subdoc to trigger dirty
    const content = doc.channel("content");
    content.getMap("test").set("key", "value");
    expect(doc.saveState.getSnapshot()).toBe("dirty");
    doc.destroy();
  });

  it("on('save') fires on change", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // Push snapshot to clear dirty state
    await doc.publish();
    expect(doc.saveState.getSnapshot()).toBe("saved");

    const states: SaveState[] = [];
    doc.on("save", (s: SaveState) => {
      states.push(s);
    });

    // Edit to trigger dirty → save-state change
    const content = doc.channel("content");
    content.getMap("test").set("k", "v");
    expect(states).toContain("dirty");
    doc.destroy();
  });

  it("lastPersistenceError Feed starts null", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.lastPersistenceError.getSnapshot()).toBeNull();
    doc.destroy();
  });

  it("lastValidationError Feed starts null", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    expect(doc.lastValidationError.getSnapshot()).toBeNull();
    doc.destroy();
  });

  it("on('publish-needed') fires", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    await doc.publish();

    let fired = false;
    doc.on("publish-needed", () => {
      fired = true;
    });

    const content = doc.channel("content");
    content.getMap("test").set("k", "v");
    expect(fired).toBe(true);
    doc.destroy();
  });

  it("destroy() is idempotent", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    doc.destroy();
    doc.destroy(); // no error
  });

  it("destroy() prevents further use", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    doc.destroy();
    expect(() => doc.channel("content")).toThrow(/destroyed/);
  });

  it("_meta populated on create", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();
    const meta = doc.channel("_meta");

    const canPush = meta.getArray("canPushSnapshots");
    expect(canPush.length).toBe(1);
    expect(canPush.get(0)).toBeInstanceOf(Uint8Array);

    const authorized = meta.getMap("authorized");
    for (const ns of OPTS.channels) {
      const arr = authorized.get(ns);
      expect(arr).toBeInstanceOf(Y.Array);
      expect((arr as Y.Array<unknown>).length).toBe(1);
    }
    doc.destroy();
  });

  describe("versionHistory()", () => {
    it("returns empty before any publish", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();
      const h = await doc.versionHistory();
      expect(h).toEqual([]);
      doc.destroy();
    });

    it("returns entries after publish", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      await doc.publish();
      const h = await doc.versionHistory();
      expect(h).toHaveLength(1);
      expect(h[0].seq).toBe(1);
      expect(h[0].ts).toBeTypeOf("number");
      expect(h[0].cid).toBeDefined();
      doc.destroy();
    });

    it("walks chain newest-first", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      await doc.publish();
      const content = doc.channel("content");
      content.getMap("test").set("k", "v");
      await doc.publish();

      const h = await doc.versionHistory();
      expect(h).toHaveLength(2);
      // newest first
      expect(h[0].seq).toBe(2);
      expect(h[1].seq).toBe(1);
      // CIDs differ
      expect(h[0].cid.toString()).not.toBe(h[1].cid.toString());
      doc.destroy();
    });

    it("falls back to local chain", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      await doc.publish();
      const content = doc.channel("content");
      content.getMap("test").set("k", "v");
      await doc.publish();
      content.getMap("test").set("k", "v2");
      await doc.publish();

      // No pinner URLs → falls back to local
      const h = await doc.versionHistory();
      expect(h).toHaveLength(3);
      expect(h[0].seq).toBe(3);
      expect(h[1].seq).toBe(2);
      expect(h[2].seq).toBe(1);
      doc.destroy();
    });
  });

  describe("loadVersion()", () => {
    it("returns Y.Doc instances with content", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const content = doc.channel("content");
      content.getMap("data").set("hello", "world");
      await doc.publish();

      const h = await doc.versionHistory();
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
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const hash = await sha256.digest(new Uint8Array([1, 2, 3]));
      const fakeCid = CID.createV1(0x71, hash);
      await expect(doc.loadVersion(fakeCid)).rejects.toThrow(/not found/i);
      doc.destroy();
    });
  });

  describe("rotate()", () => {
    it("returns new doc with same content", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const content = doc.channel("content");
      content.getMap("data").set("hello", "world");

      const { newDoc, forwardingRecord } = await doc.rotate();

      expect(forwardingRecord).toBeInstanceOf(Uint8Array);
      expect(newDoc.capability.isAdmin).toBe(true);

      const newContent = newDoc.channel("content");
      expect(newContent.getMap("data").get("hello")).toBe("world");

      // Old doc is destroyed
      expect(() => doc.channel("content")).toThrow(/destroyed/);

      // New doc has different URLs
      expect(newDoc.urls.admin).not.toBe(doc.urls.admin);
      expect(newDoc.urls.read).not.toBe(doc.urls.read);

      newDoc.destroy();
    });

    it("non-admin cannot rotate", async () => {
      const lib = pokapali(OPTS);
      const admin = await lib.create();
      const readUrl = admin.urls.read;
      admin.destroy();

      const reader = await lib.open(readUrl);
      await expect(reader.rotate()).rejects.toThrow(/Only admins can rotate/);
      reader.destroy();
    });

    it("forwarding record is verifiable", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      // Extract rotationKey before rotate destroys
      const adminUrl = doc.urls.admin!;
      const parsed = await parseUrl(adminUrl);

      const { forwardingRecord } = await doc.rotate();

      const fwd = decodeForwardingRecord(forwardingRecord);
      const valid = await verifyForwardingRecord(fwd, parsed.keys.rotationKey!);
      expect(valid).toBe(true);
    });
  });

  describe("Doc.diagnostics", () => {
    it("Diagnostics type is well-formed", () => {
      const info: Diagnostics = {
        ipfsPeers: 0,
        nodes: [],
        editors: 1,
        gossipsub: {
          peers: 0,
          topics: 0,
          meshPeers: 0,
        },
        clockSum: 0,
        maxPeerClockSum: 0,
        latestAnnouncedSeq: 0,
        ipnsSeq: null,
        loadingState: { status: "idle" },
        hasAppliedSnapshot: false,
        ackedBy: [],
        guaranteeUntil: null,
        retainUntil: null,
        topology: [],
      };
      expect(info.ipfsPeers).toBe(0);
      expect(info.nodes).toEqual([]);
      expect(info.gossipsub.meshPeers).toBe(0);
      expect(info.ackedBy).toEqual([]);
      expect(info.guaranteeUntil).toBeNull();
      expect(info.retainUntil).toBeNull();
    });
  });

  describe("Doc.ready", () => {
    it("ready returns a Promise", () => {
      type Check = ReturnType<Doc["ready"]>;
      const p: Check = Promise.resolve();
      expect(p).toBeInstanceOf(Promise);
    });
  });

  describe("forwarding detection in open()", () => {
    it("follows forwarding to new doc", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const content = doc.channel("content");
      content.getMap("data").set("key", "value");

      const oldAdminUrl = doc.urls.admin!;
      const { newDoc } = await doc.rotate();

      // Open old admin URL — should follow
      // forwarding to new doc's read URL
      const followed = await lib.open(oldAdminUrl);
      // The followed doc has a different ipnsName
      // (it resolved to the new doc)
      expect(followed.urls.read).not.toBe(oldAdminUrl);

      followed.destroy();
      newDoc.destroy();
    });
  });

  // #249: This test was flaky before ca5162a due to
  // setTimeout(0) not flushing the p2pReady async
  // chain reliably. Fixed with vi.waitFor(). The
  // retry(2) is a safety net for heavily loaded CI.
  describe("pinner discovery triggers guarantee query", () => {
    it(
      "fires queryGuarantees when new pinner" + " appears in node-registry",
      { retry: 2 },
      async () => {
        // Set up a mock registry that captures
        // the on("change") callback so we can
        // fire it manually.
        let nodeChangeCb: (() => void) | null = null;
        const mockNodes = new Map<
          string,
          {
            peerId: string;
            roles: string[];
            lastSeenAt: number;
            connected: boolean;
            stale: boolean;
            neighbors: { peerId: string; role?: string }[];
            browserCount: number;
            addrs: string[];
            httpUrl: string | undefined;
          }
        >();
        const mockRegistry = {
          nodes: mockNodes,
          on: vi.fn((_event: string, cb: () => void) => {
            nodeChangeCb = cb;
          }),
          off: vi.fn(),
          destroy: vi.fn(),
        };

        vi.mocked(acquireNodeRegistry).mockReturnValue(mockRegistry as any);
        vi.mocked(getNodeRegistry).mockReturnValue(mockRegistry as any);

        const lib = pokapali(OPTS);
        const doc = await lib.create();

        // nodeChangeHandler is registered
        // synchronously during createDoc() via
        // the topology-sharing setup path. But
        // fireGuaranteeQuery is set inside
        // startP2PLayer(), which only runs when
        // the p2pReady .then() chain completes.
        // A single setTimeout(0) is insufficient
        // because the p2pReady IIFE includes
        // dynamic import + multiple awaits whose
        // microtask count varies by environment.
        //
        // Wait for watchIPNS to be called — it's
        // invoked inside startP2PLayer(), so its
        // presence guarantees fireGuaranteeQuery
        // has been set.
        const { watchIPNS } = await import("./ipns-helpers.js");
        await vi.waitFor(
          () => {
            expect(watchIPNS).toHaveBeenCalled();
          },
          { timeout: 5000 },
        );

        // nodeChangeHandler should have been
        // registered
        expect(nodeChangeCb).not.toBeNull();

        // Clear any calls from setup
        vi.mocked(publishGuaranteeQuery).mockClear();

        // Simulate a pinner appearing in the
        // registry
        mockNodes.set("pinner-1", {
          peerId: "pinner-1",
          roles: ["pinner"],
          lastSeenAt: Date.now(),
          connected: true,
          stale: false,
          neighbors: [],
          browserCount: 0,
          addrs: [],
          httpUrl: undefined,
        });
        nodeChangeCb!();

        // publishGuaranteeQuery should fire
        expect(publishGuaranteeQuery).toHaveBeenCalled();

        // Firing again with same pinner should
        // NOT re-query (already known)
        vi.mocked(publishGuaranteeQuery).mockClear();
        nodeChangeCb!();
        expect(publishGuaranteeQuery).not.toHaveBeenCalled();

        // New pinner should trigger again
        mockNodes.set("pinner-2", {
          peerId: "pinner-2",
          roles: ["pinner"],
          lastSeenAt: Date.now(),
          connected: true,
          stale: false,
          neighbors: [],
          browserCount: 0,
          addrs: [],
          httpUrl: undefined,
        });
        nodeChangeCb!();
        expect(publishGuaranteeQuery).toHaveBeenCalled();

        doc.destroy();

        // Restore default mock behavior
        vi.mocked(acquireNodeRegistry).mockReset();
        vi.mocked(getNodeRegistry).mockReturnValue(null);
      },
    );
  });

  describe("authorize / deauthorize", () => {
    it("authorize() throws for non-admin " + "(reader)", async () => {
      const lib = pokapali(OPTS);
      const admin = await lib.create();
      const readUrl = admin.urls.read;
      admin.destroy();

      const reader = await lib.open(readUrl);
      expect(() => reader.authorize("abc123")).toThrow(/requires admin/);
      reader.destroy();
    });

    it("deauthorize() throws for non-admin " + "(reader)", async () => {
      const lib = pokapali(OPTS);
      const admin = await lib.create();
      const readUrl = admin.urls.read;
      admin.destroy();

      const reader = await lib.open(readUrl);
      expect(() => reader.deauthorize("abc123")).toThrow(/requires admin/);
      reader.destroy();
    });

    it("admin can authorize and read " + "authorizedPublishers", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      expect(doc.authorizedPublishers.size).toBe(0);

      doc.authorize("pub-a");
      expect(doc.authorizedPublishers.has("pub-a")).toBe(true);
      expect(doc.authorizedPublishers.size).toBe(1);

      doc.authorize("pub-b");
      expect(doc.authorizedPublishers.size).toBe(2);

      doc.destroy();
    });

    it("admin can deauthorize a publisher", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      doc.authorize("pub-a");
      doc.authorize("pub-b");
      expect(doc.authorizedPublishers.size).toBe(2);

      doc.deauthorize("pub-a");
      expect(doc.authorizedPublishers.has("pub-a")).toBe(false);
      expect(doc.authorizedPublishers.has("pub-b")).toBe(true);
      expect(doc.authorizedPublishers.size).toBe(1);

      doc.destroy();
    });

    it("authorizedPublishers returns " + "ReadonlySet snapshot", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      doc.authorize("pub-x");
      const snap1 = doc.authorizedPublishers;
      expect(snap1.has("pub-x")).toBe(true);

      // Mutating the Y.Map updates the getter
      doc.authorize("pub-y");
      const snap2 = doc.authorizedPublishers;
      expect(snap2.has("pub-y")).toBe(true);
      expect(snap2.size).toBe(2);

      doc.destroy();
    });
  });

  describe("lazy Helia init (#200)", () => {
    it("create() resolves before Helia finishes", async () => {
      const { acquireHelia } = await import("./helia.js");
      // Make acquireHelia hang (never resolve)

      let resolveHelia!: (v?: any) => void;
      vi.mocked(acquireHelia).mockReturnValue(
        new Promise((r) => {
          resolveHelia = r;
        }),
      );

      const lib = pokapali(OPTS);
      const doc = await lib.create();

      // Doc should be returned even though Helia
      // hasn't bootstrapped yet
      expect(doc.channel).toBeTypeOf("function");
      expect(doc.channel("content")).toBeInstanceOf(Y.Doc);

      // Clean up: resolve Helia to avoid leaks
      resolveHelia();
      doc.destroy();
    });

    it("open() resolves before Helia finishes", async () => {
      const { acquireHelia } = await import("./helia.js");

      // First create a doc to get a URL (with
      // normal Helia mock)
      vi.mocked(acquireHelia).mockResolvedValue({} as never);
      const lib = pokapali(OPTS);
      const admin = await lib.create();
      const readUrl = admin.urls.read;
      admin.destroy();

      // Now make Helia hang

      let resolveHelia!: (v?: any) => void;
      vi.mocked(acquireHelia).mockReturnValue(
        new Promise((r) => {
          resolveHelia = r;
        }),
      );

      const reader = await lib.open(readUrl);

      expect(reader.channel).toBeTypeOf("function");

      resolveHelia();
      reader.destroy();
    });
  });
});
