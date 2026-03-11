import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { parseUrl, inferCapability } from "@pokapali/capability";
import { encodeSnapshot } from "@pokapali/snapshot";
import {
  clearForwardingStore,
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
  _resetHeliaState: vi.fn(),
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
  _resetNodeRegistry: vi.fn(),
  NODE_CAPS_TOPIC: "pokapali._node-caps._p2p._pubsub",
}));

vi.mock("@pokapali/sync", () => ({
  setupNamespaceRooms: vi.fn(() => ({
    status: "connected",
    onStatusChange: vi.fn(),
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
    clearForwardingStore();
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
    expect(doc.capability.namespaces).toEqual(new Set(["content", "comments"]));
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
    expect(reader.capability.namespaces.size).toBe(0);
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
      namespaces: ["comments"],
    });
    expect(url).toContain("https://example.com/doc/");

    const parsed = await parseUrl(url);
    const cap = inferCapability(parsed.keys, OPTS.channels);
    expect(cap.namespaces).toEqual(new Set(["comments"]));
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

  it("status reflects sync state", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // With mock sync status "connected",
    // status should be "synced".
    expect(doc.status).toBe("synced");
    doc.destroy();
  });

  it("saveState reflects dirty + saving", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // After create(), _meta writes trigger dirty.
    // Push to clear.
    await doc.publish();
    expect(doc.saveState).toBe("saved");

    // Edit a subdoc to trigger dirty
    const content = doc.channel("content");
    content.getMap("test").set("key", "value");
    expect(doc.saveState).toBe("dirty");
    doc.destroy();
  });

  it("on('save') fires on change", async () => {
    const lib = pokapali(OPTS);
    const doc = await lib.create();

    // Push snapshot to clear dirty state
    await doc.publish();
    expect(doc.saveState).toBe("saved");

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

  describe("history()", () => {
    it("returns empty before any publish", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();
      const h = await doc.history();
      expect(h).toEqual([]);
      doc.destroy();
    });

    it("returns entries after publish", async () => {
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      await doc.publish();
      const h = await doc.history();
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
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const content = doc.channel("content");
      content.getMap("data").set("hello", "world");
      await doc.publish();

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
      const lib = pokapali(OPTS);
      const doc = await lib.create();

      const hash = await sha256.digest(new Uint8Array([1, 2, 3]));
      const fakeCid = CID.createV1(0x71, hash);
      await expect(doc.loadVersion(fakeCid)).rejects.toThrow(/Unknown CID/);
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

  describe("pinner discovery triggers guarantee query", () => {
    it(
      "fires queryGuarantees when new pinner" + " appears in node-registry",
      async () => {
        // Set up a mock registry that captures
        // the onNodeChange callback so we can
        // fire it manually.
        let nodeChangeCb: (() => void) | null = null;
        const mockNodes = new Map<
          string,
          {
            peerId: string;
            roles: string[];
            lastSeenAt: number;
            connected: boolean;
            neighbors: { peerId: string; role?: string }[];
            browserCount: number;
            addrs: string[];
            httpUrl: string | undefined;
          }
        >();
        const mockRegistry = {
          nodes: mockNodes,
          onNodeChange: vi.fn((cb: () => void) => {
            nodeChangeCb = cb;
          }),
          offNodeChange: vi.fn(),
          destroy: vi.fn(),
        };

        vi.mocked(acquireNodeRegistry).mockReturnValue(mockRegistry as any);
        vi.mocked(getNodeRegistry).mockReturnValue(mockRegistry as any);

        const lib = pokapali(OPTS);
        const doc = await lib.create();

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
          neighbors: [],
          browserCount: 0,
          addrs: [],
          httpUrl: undefined,
        });
        nodeChangeCb!();

        // publishGuaranteeQuery should fire
        // (called by snapshotWatcher.queryGuarantees)
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
});
