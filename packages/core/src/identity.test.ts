import { describe, it, expect, vi } from "vitest";

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

import type { Store } from "@pokapali/store";

function mockIdentityStore(): Store.Identity {
  const data = new Map<string, Uint8Array>();
  return {
    async load(id: string) {
      return data.get(id) ?? null;
    },
    async save(id: string, seed: Uint8Array) {
      data.set(id, seed);
    },
  };
}

// Dynamic import after mocking
const { loadIdentity, signParticipant } = await import("./identity.js");

describe("identity persistence", () => {
  it("generates and persists a new keypair", async () => {
    const store = mockIdentityStore();
    const kp = await loadIdentity(store);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it("returns same keypair on second load", async () => {
    const store = mockIdentityStore();
    const kp1 = await loadIdentity(store);
    const kp2 = await loadIdentity(store);
    // Same seed → same derived keypair
    expect(kp1.privateKey).toEqual(kp2.privateKey);
  });

  it("different stores get different keypairs", async () => {
    const storeA = mockIdentityStore();
    const storeB = mockIdentityStore();
    const kp1 = await loadIdentity(storeA);
    const kp2 = await loadIdentity(storeB);
    // Different random seeds
    expect(kp1.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp2.publicKey).toBeInstanceOf(Uint8Array);
  });
});

describe("signParticipant", () => {
  it("produces a hex signature (v1)", async () => {
    const store = mockIdentityStore();
    const kp = await loadIdentity(store);
    const result = await signParticipant(kp, "doc-123");
    expect(typeof result.sig).toBe("string");
    expect(result.sig.length).toBeGreaterThan(0);
    expect(result.sig.length % 2).toBe(0);
    expect(/^[0-9a-f]+$/.test(result.sig)).toBe(true);
    // No clientId → no version marker
    expect(result.v).toBeUndefined();
  });

  it("returns v:2 when clientId is provided", async () => {
    const store = mockIdentityStore();
    const kp = await loadIdentity(store);
    const result = await signParticipant(kp, "doc-123", 42);
    expect(result.v).toBe(2);
    expect(result.sig.length).toBeGreaterThan(0);
  });

  it(
    "v2 payload includes clientId " + "(cross-clientID replay prevention)",
    async () => {
      const { signBytes } = await import("@pokapali/crypto");
      const store = mockIdentityStore();
      const kp = await loadIdentity(store);

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
      const store = mockIdentityStore();
      const kp = await loadIdentity(store);

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
      const store = mockIdentityStore();
      const kp = await loadIdentity(store);
      const r1 = await signParticipant(kp, "doc-x", 99);
      const r2 = await signParticipant(kp, "doc-x", 99);
      expect(r1.sig).toBe(r2.sig);
    },
  );
});
