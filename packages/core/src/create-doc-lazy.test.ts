/**
 * Tests for lazy P2P initialization (#200).
 * createDoc should work in local-only mode when
 * syncManager/awarenessRoom/pubsub are not provided,
 * and wire up P2P when p2pReady resolves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { yjsCodec } from "@pokapali/codec";

vi.mock("@pokapali/crypto", () => ({
  hexToBytes: vi.fn(() => new Uint8Array(32)),
  bytesToHex: vi.fn(() => "00".repeat(32)),
  verifyBytes: vi.fn(async () => true),
}));

vi.mock("@pokapali/blocks", () => ({
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

vi.mock("./identity.js", () => ({
  signParticipant: vi.fn(async () => ({ sig: "mocksig", v: 2 })),
}));

vi.mock("./fetch-tip.js", () => ({
  fetchTipFromPinners: vi.fn(async () => null),
}));

vi.mock("./interpreter.js", () => ({
  runInterpreter: vi.fn(async () => {}),
}));

const { createDoc } = await import("./create-doc.js");

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
    cap: {
      isAdmin: true,
      canPushSnapshots: true,
      channels: new Set(["_meta", "content"]),
    },
    keys: {
      readKey: {} as CryptoKey,
      awarenessRoomPassword: "p",
      channelKeys: {},
    },
    ipnsName: "test-ipns",
    origin: "https://example.com",
    channels: ["_meta", "content"],
    adminUrl: "https://example.com/doc/test#admin",
    writeUrl: "https://example.com/doc/test#write",
    readUrl: "https://example.com/doc/test#r",
    signingKey: null,
    readKey: {} as CryptoKey,
    appId: "test",
    networkId: "main",
    primaryChannel: "content",
    signalingUrls: [],
    performInitialResolve: false,

    codec: yjsCodec,
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
          relayEntries: vi.fn(() => []),
          addExternalRelays: vi.fn(),
          waitForRelay: vi.fn(),
          onRelayReconnected: vi.fn(() => () => {}),
        },
      });

      // Let promise chain settle
      await vi.waitFor(() => {
        expect(runInterpreter).toHaveBeenCalled();
      });

      doc.destroy();
    });

    it(
      "channel access works before and after" +
        " p2pReady without connectChannel",
      async () => {
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

        // Access channel before P2P is ready —
        // should not throw
        expect(() => doc.channel("content")).not.toThrow();

        // Resolve with mock P2P deps (no
        // connectChannel needed)
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

        // After p2pReady, channel access still works
        await vi.waitFor(() => {
          expect(() => doc.channel("content")).not.toThrow();
        });

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
