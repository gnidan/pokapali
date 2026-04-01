/**
 * Tests for the Document bridge wiring in createDoc.
 *
 * Verifies that createDoc accepts an optional Document
 * (from @pokapali/document), stores it in the exported
 * docDocuments WeakMap, and destroys it on teardown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

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

vi.mock("./persistence.js", () => ({
  createDocPersistence: vi.fn(),
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

const { createDoc, docDocuments } = await import("./create-doc.js");

function baseParams() {
  const metaDoc = new Y.Doc({ guid: "test:_meta" });
  return {
    metaDoc,
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

    codec: {} as any,
  };
}

function mockDocument() {
  return {
    channel: vi.fn(),
    surface: vi.fn(),
    hasSurface: vi.fn().mockReturnValue(false),
    onEdit: vi.fn().mockReturnValue(() => {}),
    identity: {
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    },
    capability: {
      channels: new Set(["content"]),
      canPushSnapshots: false,
      isAdmin: false,
    },
    level: "background" as const,
    activate: vi.fn(),
    deactivate: vi.fn(),
    destroy: vi.fn(),
  };
}

describe("Document bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("docDocuments is an exported WeakMap", () => {
    expect(docDocuments).toBeInstanceOf(WeakMap);
  });

  it("createDoc stores Document in docDocuments" + " when provided", () => {
    const awareness = new Awareness(new Y.Doc());
    const document = mockDocument();
    const doc = createDoc({
      ...baseParams(),
      awareness,
      document: document as any,
    });

    expect(docDocuments.has(doc)).toBe(true);
    expect(docDocuments.get(doc)).toBe(document);
    doc.destroy();
  });

  it(
    "createDoc without document param does not" + " add to docDocuments",
    () => {
      const awareness = new Awareness(new Y.Doc());
      const doc = createDoc({
        ...baseParams(),
        awareness,
      });

      expect(docDocuments.has(doc)).toBe(false);
      doc.destroy();
    },
  );

  it("destroy() calls document.destroy() when" + " Document is present", () => {
    const awareness = new Awareness(new Y.Doc());
    const document = mockDocument();
    const doc = createDoc({
      ...baseParams(),
      awareness,
      document: document as any,
    });

    doc.destroy();

    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("Doc interface works identically with" + " Document wired in", () => {
    const awareness = new Awareness(new Y.Doc());
    const document = mockDocument();
    const doc = createDoc({
      ...baseParams(),
      awareness,
      document: document as any,
    });

    // All Doc methods should work normally
    expect(doc.channel).toBeTypeOf("function");
    expect(doc.awareness).toBe(awareness);
    expect(doc.status.getSnapshot()).toBe("connecting");
    expect(doc.urls.admin).toBe("https://example.com/doc/test#admin");
    expect(doc.role).toBe("admin");
    doc.destroy();
  });
});
