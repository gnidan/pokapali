/**
 * Tests for doc-rotate.ts — key rotation logic.
 *
 * rotateDoc() is heavily dependent on external
 * modules (crypto, subdocs, sync, capability).
 * These tests focus on validation, parameter
 * threading, and output structure.
 */
import { describe, it, expect, vi } from "vitest";
import type { RotateContext } from "./doc-rotate.js";
import type { Doc, DocParams } from "./create-doc.js";

// Mock heavy dependencies
vi.mock("@pokapali/crypto", () => ({
  generateAdminSecret: vi.fn(() => "new-secret"),
  deriveDocKeys: vi.fn(async () => ({
    readKey: {} as CryptoKey,
    ipnsKeyBytes: new Uint8Array(32),
    rotationKey: new Uint8Array(32),
    channelKeys: { content: new Uint8Array(32) },
    awarenessRoomPassword: "pass",
  })),
  ed25519KeyPairFromSeed: vi.fn(async () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
  bytesToHex: vi.fn(() => "new-ipns-name"),
}));

vi.mock("@pokapali/capability", () => ({
  inferCapability: vi.fn(() => ({
    isAdmin: true,
    canPushSnapshots: true,
    channels: new Set(["content"]),
  })),
  narrowCapability: vi.fn((keys: unknown, _opts: unknown) => keys),
  buildUrl: vi.fn(async () => "https://example.com"),
}));

vi.mock("@pokapali/subdocs", () => ({
  createSubdocManager: vi.fn(() => ({
    applySnapshot: vi.fn(),
    metaDoc: { getArray: vi.fn(), getMap: vi.fn() },
    encodeAll: vi.fn(() => new Uint8Array()),
  })),
}));

vi.mock("@pokapali/sync", () => ({
  setupNamespaceRooms: vi.fn(() => ({})),
  setupAwarenessRoom: vi.fn(() => ({})),
}));

vi.mock("./forwarding.js", () => ({
  createForwardingRecord: vi.fn(async () => ({
    oldIpnsName: "old",
    newIpnsName: "new",
    newReadUrl: "url",
    signature: new Uint8Array(),
  })),
  encodeForwardingRecord: vi.fn(() => new Uint8Array([1, 2, 3])),
  storeForwardingRecord: vi.fn(),
}));

vi.mock("./helia.js", () => ({
  getHelia: vi.fn(() => ({})),
}));

vi.mock("./peer-discovery.js", () => ({
  startRoomDiscovery: vi.fn(() => undefined),
}));

const { rotateDoc } = await import("./doc-rotate.js");

// --- Helpers ---

function baseContext(overrides?: Partial<RotateContext>): RotateContext {
  return {
    cap: {
      isAdmin: true,
      canPushSnapshots: true,
      channels: new Set(["content"]),
    },
    keys: {
      readKey: {} as CryptoKey,
      ipnsKeyBytes: new Uint8Array(32),
      rotationKey: new Uint8Array(32),
      channelKeys: { content: new Uint8Array(32) },
      awarenessRoomPassword: "pass",
    },
    ipnsName: "old-ipns-name",
    origin: "https://example.com",
    channels: ["content"],
    appId: "test-app",
    primaryChannel: "content",
    signalingUrls: ["wss://signal.example.com"],
    subdocManager: {
      encodeAll: vi.fn(() => new Uint8Array()),
      metaDoc: {},
    } as unknown as RotateContext["subdocManager"],
    ...overrides,
  } as RotateContext;
}

function mockCreateDoc(): (p: DocParams) => Doc {
  return vi.fn(() => ({ destroy: vi.fn() }) as unknown as Doc);
}

const noopPopulateMeta = vi.fn();

// --- Tests ---

describe("rotateDoc", () => {
  it("throws when not admin", async () => {
    const ctx = baseContext({
      cap: {
        isAdmin: false,
        canPushSnapshots: false,
        channels: new Set(["content"]),
      },
    });

    await expect(
      rotateDoc(ctx, mockCreateDoc(), noopPopulateMeta),
    ).rejects.toThrow("Only admins can rotate a document");
  });

  it("throws when rotationKey missing", async () => {
    const ctx = baseContext({
      keys: {
        readKey: {} as CryptoKey,
        ipnsKeyBytes: new Uint8Array(32),
        rotationKey: undefined as unknown as Uint8Array,
        channelKeys: {},
        awarenessRoomPassword: "p",
      },
    });

    await expect(
      rotateDoc(ctx, mockCreateDoc(), noopPopulateMeta),
    ).rejects.toThrow("Only admins can rotate a document");
  });

  it("returns newDoc and forwardingRecord", async () => {
    const createFn = mockCreateDoc();
    const result = await rotateDoc(baseContext(), createFn, noopPopulateMeta);

    expect(result.newDoc).toBeDefined();
    expect(result.forwardingRecord).toBeInstanceOf(Uint8Array);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it("calls createDocFn with new ipnsName", async () => {
    const createFn = mockCreateDoc();
    await rotateDoc(baseContext(), createFn, noopPopulateMeta);

    const params = (createFn as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as DocParams;
    expect(params.ipnsName).toBe("new-ipns-name");
    expect(params.appId).toBe("test-app");
    expect(params.channels).toEqual(["content"]);
  });

  it("calls populateMetaFn", async () => {
    const metaFn = vi.fn();
    await rotateDoc(baseContext(), mockCreateDoc(), metaFn);

    expect(metaFn).toHaveBeenCalledTimes(1);
  });

  it("copies state from old subdocManager", async () => {
    const encodeAll = vi.fn(() => new Uint8Array([9, 8, 7]));
    const ctx = baseContext({
      subdocManager: {
        encodeAll,
        metaDoc: {},
      } as unknown as RotateContext["subdocManager"],
    });

    await rotateDoc(ctx, mockCreateDoc(), noopPopulateMeta);

    expect(encodeAll).toHaveBeenCalled();
  });

  it("calls buildUrl three times (admin, write, read)", async () => {
    const { buildUrl } = await import("@pokapali/capability");
    (buildUrl as ReturnType<typeof vi.fn>).mockClear();

    await rotateDoc(baseContext(), mockCreateDoc(), noopPopulateMeta);

    expect(buildUrl).toHaveBeenCalledTimes(3);
  });

  it("calls narrowCapability for write and read URLs", async () => {
    const { narrowCapability } = await import("@pokapali/capability");
    (narrowCapability as ReturnType<typeof vi.fn>).mockClear();

    await rotateDoc(baseContext(), mockCreateDoc(), noopPopulateMeta);

    // narrowCapability called for write URL (with
    // canPushSnapshots:true) and read URL (without)
    expect(narrowCapability).toHaveBeenCalledTimes(2);

    const calls = (narrowCapability as ReturnType<typeof vi.fn>).mock.calls;
    // Write URL grant includes canPushSnapshots
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        canPushSnapshots: true,
      }),
    );
    // Read URL grant has no push
    expect(calls[1][1]).toEqual(
      expect.objectContaining({
        channels: [],
      }),
    );
  });

  it("threads channels to createDocFn params", async () => {
    const createFn = mockCreateDoc();
    const ctx = baseContext({
      channels: ["content", "meta"],
    });
    await rotateDoc(ctx, createFn, noopPopulateMeta);

    const params = (createFn as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as DocParams;
    expect(params.channels).toEqual(["content", "meta"]);
  });

  it("threads signalingUrls to createDocFn " + "params", async () => {
    const createFn = mockCreateDoc();
    const ctx = baseContext({
      signalingUrls: ["wss://a.example.com", "wss://b.example.com"],
    });
    await rotateDoc(ctx, createFn, noopPopulateMeta);

    const params = (createFn as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as DocParams;
    expect(params.signalingUrls).toEqual([
      "wss://a.example.com",
      "wss://b.example.com",
    ]);
  });

  it("succeeds when room discovery throws", async () => {
    const { startRoomDiscovery } = await import("./peer-discovery.js");
    (startRoomDiscovery as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("helia not ready");
      },
    );

    const createFn = mockCreateDoc();
    const result = await rotateDoc(baseContext(), createFn, noopPopulateMeta);

    // Should still succeed — room discovery is
    // optional
    expect(result.newDoc).toBeDefined();
    expect(result.forwardingRecord).toBeInstanceOf(Uint8Array);
  });

  it("stores forwarding record from old to new " + "ipnsName", async () => {
    const { storeForwardingRecord } = await import("./forwarding.js");
    (storeForwardingRecord as ReturnType<typeof vi.fn>).mockClear();

    const ctx = baseContext({
      ipnsName: "old-name-123",
    });
    await rotateDoc(ctx, mockCreateDoc(), noopPopulateMeta);

    expect(storeForwardingRecord).toHaveBeenCalledWith(
      "old-name-123",
      expect.any(Uint8Array),
    );
  });

  it(
    "passes populateMetaFn the signing public " + "key and channel keys",
    async () => {
      const metaFn = vi.fn();
      await rotateDoc(baseContext(), mockCreateDoc(), metaFn);

      expect(metaFn).toHaveBeenCalledWith(
        expect.anything(), // metaDoc
        expect.any(Uint8Array), // signing pubkey
        expect.objectContaining({
          content: expect.any(Uint8Array),
        }),
      );
    },
  );
});
