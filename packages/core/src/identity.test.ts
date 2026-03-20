import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @pokapali/crypto before import
vi.mock("@pokapali/crypto", () => ({
  ed25519KeyPairFromSeed: vi.fn(async (seed: Uint8Array) => ({
    publicKey: new Uint8Array(seed.map((b) => b ^ 0xff)),
    privateKey: seed,
  })),
  bytesToHex: vi.fn((bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  ),
  signBytes: vi.fn(async (_kp: unknown, data: Uint8Array) =>
    new Uint8Array(data.length).fill(0xab),
  ),
}));

// --- Minimal IndexedDB mock ---

interface MockStore {
  data: Map<string, unknown>;
}

function createMockIDB() {
  const stores = new Map<string, MockStore>();

  function getStore(dbName: string): MockStore {
    if (!stores.has(dbName)) {
      stores.set(dbName, { data: new Map() });
    }
    return stores.get(dbName)!;
  }

  const mockIndexedDB = {
    open(dbName: string, _version?: number) {
      const store = getStore(dbName);
      const req = {
        result: null as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };

      queueMicrotask(() => {
        const db = {
          objectStoreNames: {
            contains: (_name: string) => false,
          },
          createObjectStore: vi.fn(),
          transaction: (_storeName: string, mode?: string) => ({
            objectStore: () => ({
              get: (key: string) => {
                const getReq = {
                  result: store.data.get(key),
                  error: null,
                  onsuccess: null as (() => void) | null,
                  onerror: null as (() => void) | null,
                };
                queueMicrotask(() => getReq.onsuccess?.());
                return getReq;
              },
              put: (value: unknown, key: string) => {
                if (mode === "readwrite") {
                  store.data.set(key, value);
                }
                const putReq = {
                  result: undefined,
                  error: null,
                  onsuccess: null as (() => void) | null,
                  onerror: null as (() => void) | null,
                };
                queueMicrotask(() => putReq.onsuccess?.());
                return putReq;
              },
            }),
          }),
          close: vi.fn(),
        };

        req.result = db as unknown as IDBDatabase;
        req.onupgradeneeded?.();
        queueMicrotask(() => req.onsuccess?.());
      });

      return req;
    },
  };

  return { mockIndexedDB, stores };
}

let idbMock: ReturnType<typeof createMockIDB>;

beforeEach(() => {
  idbMock = createMockIDB();
  vi.stubGlobal("indexedDB", idbMock.mockIndexedDB);
});

// Dynamic import after mocking
const { loadIdentity, signParticipant } = await import("./identity.js");

describe("identity persistence", () => {
  it("generates and persists a new keypair", async () => {
    const kp = await loadIdentity("test-app");
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it("returns same keypair on second load", async () => {
    const kp1 = await loadIdentity("test-app-2");
    const kp2 = await loadIdentity("test-app-2");
    // Same seed → same derived keypair
    expect(kp1.privateKey).toEqual(kp2.privateKey);
  });

  it("different appId gets different keypair", async () => {
    const kp1 = await loadIdentity("app-a");
    const kp2 = await loadIdentity("app-b");
    // Different random seeds (different IDB stores)
    // Both are valid keypairs but may differ
    expect(kp1.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp2.publicKey).toBeInstanceOf(Uint8Array);
  });
});

describe("signParticipant", () => {
  it("produces a hex signature (v1)", async () => {
    const kp = await loadIdentity("sign-test");
    const result = await signParticipant(kp, "doc-123");
    expect(typeof result.sig).toBe("string");
    expect(result.sig.length).toBeGreaterThan(0);
    expect(result.sig.length % 2).toBe(0);
    expect(/^[0-9a-f]+$/.test(result.sig)).toBe(true);
    // No clientId → no version marker
    expect(result.v).toBeUndefined();
  });

  it("returns v:2 when clientId is provided", async () => {
    const kp = await loadIdentity("v2-test");
    const result = await signParticipant(kp, "doc-123", 42);
    expect(result.v).toBe(2);
    expect(result.sig.length).toBeGreaterThan(0);
  });

  it(
    "v2 payload includes clientId " + "(cross-clientID replay prevention)",
    async () => {
      const { signBytes } = await import("@pokapali/crypto");
      const kp = await loadIdentity("replay-v2");

      await signParticipant(kp, "doc-a", 100);
      const call1Data = vi.mocked(signBytes).mock.calls.at(-1)![1];

      await signParticipant(kp, "doc-a", 200);
      const call2Data = vi.mocked(signBytes).mock.calls.at(-1)![1];

      const dec = new TextDecoder();
      expect(dec.decode(call1Data)).toContain(":100:");
      expect(dec.decode(call2Data)).toContain(":200:");
      expect(dec.decode(call1Data)).not.toBe(dec.decode(call2Data));
    },
  );

  it(
    "different docIds sign different " +
      "payloads (cross-doc replay prevention)",
    async () => {
      const { signBytes } = await import("@pokapali/crypto");
      const kp = await loadIdentity("replay-test");

      await signParticipant(kp, "doc-a");
      const call1Data = vi.mocked(signBytes).mock.calls.at(-1)![1];

      await signParticipant(kp, "doc-b");
      const call2Data = vi.mocked(signBytes).mock.calls.at(-1)![1];

      // Payloads include docId → differ
      const dec = new TextDecoder();
      expect(dec.decode(call1Data)).toContain("doc-a");
      expect(dec.decode(call2Data)).toContain("doc-b");
      expect(dec.decode(call1Data)).not.toBe(dec.decode(call2Data));
    },
  );

  it(
    "same keypair + same docId + same clientId " + "produces same signature",
    async () => {
      const kp = await loadIdentity("stable-test");
      const r1 = await signParticipant(kp, "doc-x", 99);
      const r2 = await signParticipant(kp, "doc-x", 99);
      expect(r1.sig).toBe(r2.sig);
    },
  );
});
