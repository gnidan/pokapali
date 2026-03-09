import {
  describe, it, expect, vi, beforeEach,
} from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_CBOR_CODE = 0x71;

async function fakeCID(label: string): Promise<CID> {
  const bytes = new TextEncoder().encode(label);
  const hash = await sha256.digest(bytes);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

// --- mocks ---

const {
  mockPublish,
  mockResolve,
  mockIpns,
  mockGenerateKeyPairFromSeed,
  mockPublicKeyFromRaw,
} = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue({});
  const mockResolve = vi.fn();
  const mockIpns = vi.fn().mockReturnValue({
    publish: mockPublish,
    resolve: mockResolve,
  });
  const mockGenerateKeyPairFromSeed = vi.fn();
  const mockPublicKeyFromRaw = vi.fn();
  return {
    mockPublish,
    mockResolve,
    mockIpns,
    mockGenerateKeyPairFromSeed,
    mockPublicKeyFromRaw,
  };
});

vi.mock("@helia/ipns", () => ({
  ipns: mockIpns,
}));

vi.mock("@libp2p/crypto/keys", () => ({
  generateKeyPairFromSeed: mockGenerateKeyPairFromSeed,
  publicKeyFromRaw: mockPublicKeyFromRaw,
}));

import {
  publishIPNS,
  resolveIPNS,
  watchIPNS,
} from "./ipns-helpers.js";

const fakeHelia = { fake: "helia" } as any;

describe("publishIPNS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts seed to private key and publishes", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid = await fakeCID("test");
    const fakePrivKey = { type: "Ed25519" };
    mockGenerateKeyPairFromSeed.mockResolvedValue(
      fakePrivKey,
    );

    await publishIPNS(fakeHelia, seed, cid);

    expect(
      mockGenerateKeyPairFromSeed,
    ).toHaveBeenCalledWith("Ed25519", seed);
    expect(mockIpns).toHaveBeenCalledWith(fakeHelia);
    expect(mockPublish).toHaveBeenCalledWith(
      fakePrivKey,
      cid,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("resolveIPNS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a public key to a CID", async () => {
    const pubBytes = new Uint8Array(32).fill(2);
    const cid = await fakeCID("resolved");
    const fakePubKey = { type: "Ed25519" };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockResolve.mockResolvedValue({
      cid,
      path: "",
    });

    const result = await resolveIPNS(
      fakeHelia,
      pubBytes,
    );

    expect(mockPublicKeyFromRaw).toHaveBeenCalledWith(
      pubBytes,
    );
    expect(mockResolve).toHaveBeenCalledWith(
      fakePubKey,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toBe(cid);
  });

  it("returns null on resolution failure", async () => {
    const pubBytes = new Uint8Array(32).fill(3);
    const fakePubKey = { type: "Ed25519" };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockResolve.mockRejectedValue(
      new Error("not found"),
    );

    const result = await resolveIPNS(
      fakeHelia,
      pubBytes,
    );

    expect(result).toBeNull();
  });
});

describe("watchIPNS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("calls onUpdate when CID changes", async () => {
    const pubBytes = new Uint8Array(32).fill(4);
    const cid1 = await fakeCID("v1");
    const cid2 = await fakeCID("v2");
    const fakePubKey = { type: "Ed25519" };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);

    let resolveCount = 0;
    mockResolve.mockImplementation(async () => {
      resolveCount++;
      if (resolveCount <= 2) {
        return { cid: cid1, path: "" };
      }
      return { cid: cid2, path: "" };
    });

    const onUpdate = vi.fn();
    const stop = watchIPNS(
      fakeHelia,
      pubBytes,
      onUpdate,
      100,
    );

    // First poll fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(cid1);

    // Second poll — same CID, no new call
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Third poll — CID changes
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith(cid2);

    stop();
  });

  it("stop() prevents further polling", async () => {
    const pubBytes = new Uint8Array(32).fill(5);
    const cid = await fakeCID("stop-test");
    const fakePubKey = { type: "Ed25519" };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockResolve.mockResolvedValue({
      cid,
      path: "",
    });

    const onUpdate = vi.fn();
    const stop = watchIPNS(
      fakeHelia,
      pubBytes,
      onUpdate,
      100,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    stop();

    await vi.advanceTimersByTimeAsync(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("ignores poll errors gracefully", async () => {
    const pubBytes = new Uint8Array(32).fill(6);
    const cid = await fakeCID("after-error");
    const fakePubKey = { type: "Ed25519" };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);

    let callCount = 0;
    mockResolve.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network error");
      }
      return { cid, path: "" };
    });

    const onUpdate = vi.fn();
    const stop = watchIPNS(
      fakeHelia,
      pubBytes,
      onUpdate,
      100,
    );

    // First poll fails
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();

    // Second poll succeeds
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(cid);

    stop();
  });
});
