/**
 * Solo-mode tests: single peer, no relay connections.
 *
 * Verifies that core doc operations work without
 * any relay or remote peers: create, write, persist,
 * reopen, publish. No errors should surface from
 * missing network connectivity.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import * as Y from "yjs";

// Stub window so the browser-environment guard in
// pokapali() doesn't trip in Node/vitest.
const hadWindow = typeof window !== "undefined";
if (!hadWindow) {
  // @ts-expect-error — minimal stub
  globalThis.window = {};
}
afterAll(() => {
  if (!hadWindow) {
    // @ts-expect-error — removing stub
    delete globalThis.window;
  }
});
// Mock helia with zero subscribers (no relays)
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

// Announce returns no acks, no peers — solo mode
vi.mock("./announce.js", () => ({
  announceSnapshot: vi.fn().mockResolvedValue(undefined),
  announceTopic: vi.fn().mockReturnValue("/pokapali/app/solo-test/announce"),
  parseAnnouncement: vi.fn().mockReturnValue(null),
  parseGuaranteeResponse: vi.fn().mockReturnValue(null),
  publishGuaranteeQuery: vi.fn().mockResolvedValue(undefined),
  MAX_INLINE_BLOCK_BYTES: 1024 * 1024,
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

// Sync reports disconnected — no relay peers
vi.mock("@pokapali/sync", () => ({
  SNAPSHOT_ORIGIN: Symbol("snapshot-apply"),
  setupNamespaceRooms: vi.fn(() => ({
    status: "disconnected",
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
  signParticipant: vi.fn(async () => ({ sig: "mocksig", v: 2 })),
}));

// Shared mock history so tests can inspect
// persist calls across Store.Document handles.
const mockHistoryAppend = vi.fn(async () => {});
const mockHistoryLoad = vi.fn(async () => []);

vi.mock("@pokapali/store", () => ({
  Store: {
    create: vi.fn(async () => ({
      identity: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => {}),
      },
      documents: {
        get: vi.fn(() => ({
          history: vi.fn(() => ({
            append: mockHistoryAppend,
            close: vi.fn(async () => {}),
            load: mockHistoryLoad,
          })),
          snapshots: {
            append: vi.fn(async () => {}),
            loadAll: vi.fn(async () => []),
          },
          viewCache: {
            load: vi.fn(async () => null),
            save: vi.fn(async () => {}),
          },
          destroy: vi.fn(async () => {}),
        })),
      },
      close: vi.fn(),
    })),
  },
}));

vi.mock("@pokapali/blocks", async () => {
  const actual =
    await vi.importActual<typeof import("@pokapali/blocks")>(
      "@pokapali/blocks",
    );
  return {
    ...actual,
    encodeSnapshot: vi.fn(actual.encodeSnapshot),
  };
});

import { pokapali } from "./index.js";
import { encodeSnapshot } from "@pokapali/blocks";

const SOLO_OPTS = {
  appId: "solo-test",
  channels: ["content"],
  origin: "https://example.com",
};

describe("solo mode (no relay)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create() succeeds without relays", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();
    expect(doc.channel).toBeTypeOf("function");
    expect(doc.capability.isAdmin).toBe(true);
    doc.destroy();
  });

  it("write content without relays", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    const content = doc.channel("content");
    content.getText("body").insert(0, "solo edit");
    expect(content.getText("body").toString()).toBe("solo edit");
    doc.destroy();
  });

  it("publish() works without relays", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    spy.mockClear();
    await doc.publish();
    expect(spy).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it("multiple publishes build chain in solo mode", async () => {
    const spy = vi.mocked(encodeSnapshot);
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    spy.mockClear();
    await doc.publish();
    expect(spy.mock.calls[0]![3]).toBe(1); // seq
    expect(spy.mock.calls[0]![2]).toBeNull(); // prev

    await doc.publish();
    expect(spy.mock.calls[1]![3]).toBe(2);
    expect(spy.mock.calls[1]![2]).not.toBeNull();

    await doc.publish();
    expect(spy.mock.calls[2]![3]).toBe(3);
    expect(spy.mock.calls[2]![2]).not.toBeNull();
    doc.destroy();
  });

  it(
    "status is connecting during mesh grace " + "period when solo",
    async () => {
      const lib = pokapali(SOLO_OPTS);
      const doc = await lib.create();
      // During mesh formation grace period,
      // status is "connecting" not "offline"
      expect(doc.status.getSnapshot()).toBe("connecting");
      doc.destroy();
    },
  );

  it("save state transitions work solo", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    // Publish to clear initial dirty
    await doc.publish();
    expect(doc.saveState.getSnapshot()).toBe("saved");

    // Edit triggers dirty
    const content = doc.channel("content");
    content.getMap("test").set("k", "v");
    expect(doc.saveState.getSnapshot()).toBe("dirty");

    // Publish clears dirty
    await doc.publish();
    expect(doc.saveState.getSnapshot()).toBe("saved");
    doc.destroy();
  });

  it("destroy() is clean without relays", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    // Write some content first
    doc.channel("content").getText("t").insert(0, "x");
    await doc.publish();

    // destroy should not throw
    doc.destroy();
    expect(() => doc.channel("content")).toThrow(/destroyed/);
  });

  it("reopen doc via URL preserves identity", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();
    const adminUrl = doc.urls.admin;
    doc.destroy();

    // Reopen from the admin URL
    const reopened = await lib.open(adminUrl!);
    expect(reopened.capability.isAdmin).toBe(true);
    expect(reopened.capability.canPushSnapshots).toBe(true);
    reopened.destroy();
  });

  it("publish-needed event fires in solo mode", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();
    await doc.publish();

    let fired = false;
    doc.on("publish-needed", () => {
      fired = true;
    });

    doc.channel("content").getMap("m").set("a", 1);
    expect(fired).toBe(true);
    doc.destroy();
  });

  it("URLs are valid in solo mode", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    expect(doc.urls.admin).toContain("https://example.com/doc/");
    expect(doc.urls.write).toContain("https://example.com/doc/");
    expect(doc.urls.read).toContain("https://example.com/doc/");
    doc.destroy();
  });

  it("local edits are persisted to Store", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    mockHistoryAppend.mockClear();
    doc.channel("content").getText("body").insert(0, "hello");

    // Fire-and-forget persist — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(mockHistoryAppend).toHaveBeenCalled();
    const call = mockHistoryAppend.mock.calls[0] as
      | [number, { payload: Uint8Array; origin: string }]
      | undefined;
    expect(call).toBeDefined();
    const [epochIndex, edit] = call!;
    expect(epochIndex).toBe(0);
    expect(edit.payload).toBeInstanceOf(Uint8Array);
    expect(edit.origin).toBe("local");
    doc.destroy();
  });

  it("backedUp feed starts false in solo mode", async () => {
    const lib = pokapali(SOLO_OPTS);
    const doc = await lib.create();

    expect(doc.backedUp.getSnapshot()).toBe(false);

    // Publish — still no pinners, so stays false
    await doc.publish();
    expect(doc.backedUp.getSnapshot()).toBe(false);
    doc.destroy();
  });
});
