/**
 * Tests for lazy P2P initialization (#200).
 * createDoc should work in local-only mode when
 * syncManager/awarenessRoom/pubsub are not provided,
 * and wire up P2P when p2pReady resolves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

vi.mock("@pokapali/crypto", () => ({
  hexToBytes: vi.fn(() => new Uint8Array(32)),
  bytesToHex: vi.fn(() => "00".repeat(32)),
  verifyBytes: vi.fn(async () => true),
}));

vi.mock("@pokapali/snapshot", () => ({
  decodeSnapshot: vi.fn(() => ({
    seq: 1,
    prev: null,
  })),
}));

vi.mock("./helia.js", () => ({
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
  releaseHelia: vi.fn(),
}));

vi.mock("./ipns-helpers.js", () => ({
  publishIPNS: vi.fn(),
  resolveIPNS: vi.fn().mockResolvedValue(null),
  watchIPNS: vi.fn(() => vi.fn()),
}));

vi.mock("./announce.js", () => ({
  announceTopic: vi.fn(() => "test-topic"),
  announceSnapshot: vi.fn(),
  parseAnnouncement: vi.fn(() => null),
  parseGuaranteeResponse: vi.fn(() => null),
  publishGuaranteeQuery: vi.fn(),
  base64ToUint8: vi.fn(),
  MAX_INLINE_BLOCK_BYTES: 262144,
}));

vi.mock("./node-registry.js", () => ({
  getNodeRegistry: vi.fn(() => null),
}));

vi.mock("./peer-discovery.js", () => ({
  startRoomDiscovery: vi.fn(),
}));

vi.mock("./snapshot-codec.js", () => ({
  createSnapshotCodec: vi.fn(() => ({
    applyRemote: vi.fn(),
    push: vi.fn(),
    prev: null,
    lastIpnsSeq: null,
    history: vi.fn(),
    loadVersion: vi.fn(),
    setLastIpnsSeq: vi.fn(),
  })),
}));

vi.mock("./relay-sharing.js", () => ({
  createRelaySharing: vi.fn(),
}));

vi.mock("./topology-sharing.js", () => ({
  createTopologySharing: vi.fn(),
}));

vi.mock("./persistence.js", () => ({
  createDocPersistence: vi.fn(),
}));

vi.mock("./identity.js", () => ({
  signParticipant: vi.fn(async () => "mocksig"),
}));

vi.mock("./fetch-tip.js", () => ({
  fetchTipFromPinners: vi.fn(async () => null),
}));

vi.mock("./interpreter.js", () => ({
  runInterpreter: vi.fn(async () => {}),
}));

const { createDoc } = await import("./create-doc.js");

function mockSubdocManager() {
  const metaDoc = new Y.Doc({ guid: "test:_meta" });
  return {
    subdoc: vi.fn((ns: string) => {
      if (ns === "_meta") return metaDoc;
      return new Y.Doc({ guid: `test:${ns}` });
    }),
    metaDoc,
    encodeAll: vi.fn(() => ({})),
    applySnapshot: vi.fn(),
    isDirty: false,
    on: vi.fn(),
    off: vi.fn(),
    whenLoaded: Promise.resolve(),
    destroy: vi.fn(),
  };
}

function mockPubsub() {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSubscribers: vi.fn(() => []),
    getTopics: vi.fn(() => []),
  } as any;
}

function baseParams() {
  return {
    subdocManager: mockSubdocManager() as ReturnType<typeof mockSubdocManager>,
    cap: {
      isAdmin: true,
      canPushSnapshots: true,
      channels: new Set(["content"]),
    },
    keys: {
      readKey: {} as CryptoKey,
      awarenessRoomPassword: "p",
      channelKeys: {},
    },
    ipnsName: "test-ipns",
    origin: "https://example.com",
    channels: ["content"],
    adminUrl: "https://example.com/doc/test#admin",
    writeUrl: "https://example.com/doc/test#write",
    readUrl: "https://example.com/doc/test#r",
    signingKey: null,
    readKey: {} as CryptoKey,
    appId: "test",
    primaryChannel: "content",
    signalingUrls: [],
    performInitialResolve: false,
  };
}

describe("lazy P2P init (#200)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("local-only mode", () => {
    it(
      "createDoc works without syncManager," + " awarenessRoom, or pubsub",
      () => {
        const awareness = new Awareness(new Y.Doc());
        const doc = createDoc({
          ...baseParams(),
          awareness,
        });

        expect(doc.channel).toBeTypeOf("function");
        expect(doc.awareness).toBe(awareness);
        expect(doc.destroy).toBeTypeOf("function");
        doc.destroy();
      },
    );

    it("status is 'connecting' without syncManager", () => {
      const awareness = new Awareness(new Y.Doc());
      const doc = createDoc({
        ...baseParams(),
        awareness,
      });

      expect(doc.status.getSnapshot()).toBe("connecting");
      doc.destroy();
    });

    it("ready() resolves in local-only create mode", async () => {
      const awareness = new Awareness(new Y.Doc());
      const doc = createDoc({
        ...baseParams(),
        awareness,
        performInitialResolve: false,
      });

      await expect(doc.ready()).resolves.toBeUndefined();
      doc.destroy();
    });
  });

  describe("p2pReady wiring", () => {
    it("starts interpreter when p2pReady resolves", async () => {
      const { runInterpreter } = await import("./interpreter.js");

      const awareness = new Awareness(new Y.Doc());
      let resolveP2P!: (deps: unknown) => void;
      const p2pReady = new Promise((resolve) => {
        resolveP2P = resolve;
      });

      const doc = createDoc({
        ...baseParams(),
        awareness,

        p2pReady: p2pReady as any,
      });

      // Before p2pReady: no interpreter
      expect(runInterpreter).not.toHaveBeenCalled();

      // Resolve with mock P2P deps
      resolveP2P({
        pubsub: mockPubsub(),
        syncManager: {
          status: "connected",
          onStatusChange: vi.fn(),
          destroy: vi.fn(),
        },
        awarenessRoom: {
          awareness,
          connected: true,
          onStatusChange: vi.fn(),
          destroy: vi.fn(),
        },
        roomDiscovery: {
          stop: vi.fn(),
          relayPeerIds: new Set(),
          addExternalRelays: vi.fn(),
        },
      });

      // Let promise chain settle
      await vi.waitFor(() => {
        expect(runInterpreter).toHaveBeenCalled();
      });

      doc.destroy();
    });

    it(
      "channel access before p2pReady defers" + " connectChannel until resolve",
      async () => {
        const awareness = new Awareness(new Y.Doc());
        let resolveP2P!: (deps: unknown) => void;
        const p2pReady = new Promise((resolve) => {
          resolveP2P = resolve;
        });

        const connectChannel = vi.fn();
        const doc = createDoc({
          ...baseParams(),
          awareness,

          p2pReady: p2pReady as any,
        });

        // Access channel before P2P is ready
        doc.channel("content");

        // connectChannel hasn't been called yet
        // (syncManager doesn't exist)
        expect(connectChannel).not.toHaveBeenCalled();

        // Resolve with mock P2P deps
        resolveP2P({
          pubsub: mockPubsub(),
          syncManager: {
            status: "connected",
            onStatusChange: vi.fn(),
            connectChannel,
            destroy: vi.fn(),
          },
          awarenessRoom: {
            awareness,
            connected: true,
            onStatusChange: vi.fn(),
            destroy: vi.fn(),
          },
          roomDiscovery: {
            stop: vi.fn(),
            relayPeerIds: new Set(),
            addExternalRelays: vi.fn(),
          },
        });

        // After p2pReady, connectChannel should be
        // called for the previously-accessed channel
        await vi.waitFor(() => {
          expect(connectChannel).toHaveBeenCalledWith("content");
        });

        doc.destroy();
      },
    );

    it(
      "channel access after p2pReady calls" + " connectChannel immediately",
      async () => {
        const awareness = new Awareness(new Y.Doc());
        const connectChannel = vi.fn();

        const doc = createDoc({
          ...baseParams(),
          awareness,

          p2pReady: Promise.resolve({
            pubsub: mockPubsub(),
            syncManager: {
              status: "connected",
              onStatusChange: vi.fn(),
              connectChannel,
              destroy: vi.fn(),
            },
            awarenessRoom: {
              awareness,
              connected: true,
              onStatusChange: vi.fn(),
              destroy: vi.fn(),
            },
            roomDiscovery: {
              stop: vi.fn(),
              relayPeerIds: new Set(),
              addExternalRelays: vi.fn(),
            },
          }) as any,
        });

        // Wait for p2pReady to settle
        await vi.waitFor(() => {
          expect(connectChannel).not.toThrow();
        });
        await new Promise((r) => setTimeout(r, 0));

        connectChannel.mockClear();

        // Access channel after P2P is ready
        doc.channel("content");

        // connectChannel called immediately
        expect(connectChannel).toHaveBeenCalledWith("content");

        doc.destroy();
      },
    );

    it("doc still works when p2pReady rejects", async () => {
      const awareness = new Awareness(new Y.Doc());
      const p2pReady = Promise.reject(new Error("Helia bootstrap failed"));
      // Prevent unhandled rejection
      p2pReady.catch(() => {});

      const doc = createDoc({
        ...baseParams(),
        awareness,

        p2pReady: p2pReady as any,
        performInitialResolve: false,
      });

      // Doc should still work locally
      expect(doc.channel).toBeTypeOf("function");

      // ready() should still resolve (create mode)
      await expect(doc.ready()).resolves.toBeUndefined();

      doc.destroy();
    });
  });
});
