/**
 * Tests that ready() resolves even when the
 * interpreter crashes (GH #39).
 */
import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies
vi.mock("@pokapali/crypto", () => ({
  hexToBytes: vi.fn(() => new Uint8Array(32)),
  bytesToHex: vi.fn(() => "00".repeat(32)),
  verifySignature: vi.fn(async () => true),
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

// Mock interpreter to crash immediately
vi.mock("./interpreter.js", () => ({
  runInterpreter: vi.fn(async () => {
    throw new Error("interpreter boom");
  }),
}));

const { createDoc } = await import("./create-doc.js");

function mockSubdocManager() {
  const doc = {
    getArray: vi.fn(() => ({ push: vi.fn() })),
    getMap: vi.fn(() => ({
      set: vi.fn(),
      size: 0,
      observe: vi.fn(),
      unobserve: vi.fn(),
      entries: vi.fn(() => []),
    })),
    guid: "test:_meta",
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    subdoc: vi.fn(() => doc),
    metaDoc: doc,
    encodeAll: vi.fn(() => ({})),
    applySnapshot: vi.fn(),
    isDirty: false,
    on: vi.fn(),
    off: vi.fn(),
    whenLoaded: Promise.resolve(),
    destroy: vi.fn(),
  };
}

describe("ready() after interpreter crash (#39)", () => {
  it("resolves ready() when interpreter throws", async () => {
    const doc = createDoc({
      subdocManager: mockSubdocManager() as any,
      syncManager: {
        status: "connecting",
        onStatusChange: vi.fn(),
        destroy: vi.fn(),
      } as any,
      awarenessRoom: {
        awareness: {
          on: vi.fn(),
          off: vi.fn(),
          setLocalStateField: vi.fn(),
          getStates: () => new Map(),
        },
        connected: false,
        onStatusChange: vi.fn(),
        destroy: vi.fn(),
      } as any,
      cap: {
        isAdmin: false,
        canPushSnapshots: false,
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
      adminUrl: null,
      writeUrl: null,
      readUrl: "https://example.com/doc/test#r",
      signingKey: null,
      readKey: {} as CryptoKey,
      appId: "test",
      primaryChannel: "content",
      signalingUrls: [],
      syncOpts: {
        peerOpts: {},
        pubsub: {
          subscribe: vi.fn(),
          unsubscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getSubscribers: vi.fn(() => []),
          getTopics: vi.fn(() => []),
        } as any,
      },
      pubsub: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getSubscribers: vi.fn(() => []),
        getTopics: vi.fn(() => []),
      } as any,
      performInitialResolve: true,
    });

    // ready() should resolve (not hang) even
    // though the interpreter crashed.
    const result = await Promise.race([
      doc.ready().then(() => "resolved"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);

    expect(result).toBe("resolved");
    doc.destroy();
  });
});
