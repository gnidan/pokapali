import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { identity } from "multiformats/hashes/identity";

const DAG_CBOR_CODE = 0x71;

async function fakeCID(label: string): Promise<CID> {
  const bytes = new TextEncoder().encode(label);
  const hash = await sha256.digest(bytes);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

// --- mocks ---

const {
  mockCreateIPNSRecord,
  mockGenerateKeyPairFromSeed,
  mockPublicKeyFromRaw,
  mockIpns,
  mockResolve,
} = vi.hoisted(() => {
  const mockCreateIPNSRecord = vi
    .fn()
    .mockResolvedValue({ value: "/ipfs/test" });
  const mockResolve = vi.fn();
  const mockIpns = vi.fn().mockReturnValue({
    resolve: mockResolve,
  });
  const mockGenerateKeyPairFromSeed = vi.fn();
  const mockPublicKeyFromRaw = vi.fn();
  return {
    mockCreateIPNSRecord,
    mockGenerateKeyPairFromSeed,
    mockPublicKeyFromRaw,
    mockIpns,
    mockResolve,
  };
});

vi.mock("ipns", () => ({
  createIPNSRecord: mockCreateIPNSRecord,
}));

vi.mock("@helia/ipns", () => ({
  ipns: mockIpns,
}));

vi.mock("@libp2p/crypto/keys", () => ({
  generateKeyPairFromSeed: mockGenerateKeyPairFromSeed,
  publicKeyFromRaw: mockPublicKeyFromRaw,
}));

import { publishIPNS, resolveIPNS, watchIPNS } from "./ipns-helpers.js";

const mockPutIPNS = vi.fn().mockResolvedValue(undefined);
const mockGetIPNS = vi.fn();
const fakeHelia = {
  fake: "helia",
  libp2p: {
    services: {
      delegatedRouting: {
        putIPNS: mockPutIPNS,
        getIPNS: mockGetIPNS,
      },
    },
  },
} as any;

describe("publishIPNS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates record with clock sum seq and publishes via delegated routing", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid = await fakeCID("test");
    const fakeRecord = { value: "/ipfs/test" };
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    const fakePrivKey = {
      type: "Ed25519",
      publicKey: fakePubKey,
    };
    mockGenerateKeyPairFromSeed.mockResolvedValue(fakePrivKey);
    mockCreateIPNSRecord.mockResolvedValue(fakeRecord);
    // No existing IPNS record
    mockGetIPNS.mockRejectedValue(new Error("not found"));

    await publishIPNS(fakeHelia, seed, cid, 42);

    expect(mockGenerateKeyPairFromSeed).toHaveBeenCalledWith("Ed25519", seed);
    // createIPNSRecord called with seq from clock sum
    expect(mockCreateIPNSRecord).toHaveBeenCalledWith(
      fakePrivKey,
      cid,
      42n,
      expect.any(Number),
    );
    // delegated HTTP publish
    expect(mockPutIPNS).toHaveBeenCalledWith(
      expect.anything(),
      fakeRecord,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps clockSum seq when it exceeds existing", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid = await fakeCID("ahead");
    const fakeRecord = { value: "/ipfs/ahead" };
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    const fakePrivKey = {
      type: "Ed25519",
      publicKey: fakePubKey,
    };
    mockGenerateKeyPairFromSeed.mockResolvedValue(fakePrivKey);
    mockCreateIPNSRecord.mockResolvedValue(fakeRecord);
    // Existing record has seq=10, clock sum is 500
    mockGetIPNS.mockResolvedValue({
      sequence: 10n,
      value: "/ipfs/old",
    });

    await publishIPNS(fakeHelia, seed, cid, 500);

    // Should use 500n (clockSum), not 11n
    expect(mockCreateIPNSRecord).toHaveBeenCalledWith(
      fakePrivKey,
      cid,
      500n,
      expect.any(Number),
    );
  });

  it("skips publish when no delegatedRouting.putIPNS", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid = await fakeCID("no-delegated");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    const fakePrivKey = {
      type: "Ed25519",
      publicKey: fakePubKey,
    };
    mockGenerateKeyPairFromSeed.mockResolvedValue(fakePrivKey);

    const noDelegatedHelia = {
      fake: "helia",
      libp2p: { services: {} },
    } as any;

    await publishIPNS(noDelegatedHelia, seed, cid, 1);

    // Should not attempt to create or put a record
    expect(mockCreateIPNSRecord).not.toHaveBeenCalled();
    expect(mockPutIPNS).not.toHaveBeenCalled();
  });

  it("coalesces queued publishes, skipping stale CIDs", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid1 = await fakeCID("stale");
    const cid2 = await fakeCID("latest");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    const fakePrivKey = {
      type: "Ed25519",
      publicKey: fakePubKey,
    };
    mockGenerateKeyPairFromSeed.mockResolvedValue(fakePrivKey);
    mockGetIPNS.mockRejectedValue(new Error("not found"));

    // Make the first publish hang until we resolve it
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const fakeRecord = { value: "/ipfs/test" };
    let callCount = 0;
    mockCreateIPNSRecord.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        await firstBlock;
      }
      return fakeRecord;
    });

    // Fire first publish (will block)
    const p1 = publishIPNS(fakeHelia, seed, cid1, 10);
    // Queue two more while first is in flight —
    // only the last should actually publish
    const p2 = publishIPNS(fakeHelia, seed, cid2, 20);

    // Unblock the first publish
    resolveFirst();
    await Promise.all([p1, p2]);

    // createIPNSRecord called twice: once for cid1
    // (the in-flight), once for cid2 (the coalesced
    // pending). cid2 replaces any earlier pending.
    expect(mockCreateIPNSRecord).toHaveBeenCalledTimes(2);
    const secondCall = mockCreateIPNSRecord.mock.calls[1]!;
    expect(secondCall[1].toString()).toBe(cid2.toString());
    expect(secondCall[2]).toBe(20n);
  });

  it("uses existing seq + 1 when clock sum is lower", async () => {
    const seed = new Uint8Array(32).fill(1);
    const cid = await fakeCID("bump");
    const fakeRecord = { value: "/ipfs/bump" };
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    const fakePrivKey = {
      type: "Ed25519",
      publicKey: fakePubKey,
    };
    mockGenerateKeyPairFromSeed.mockResolvedValue(fakePrivKey);
    mockCreateIPNSRecord.mockResolvedValue(fakeRecord);
    // Existing record has seq=100, clock sum is 42
    mockGetIPNS.mockResolvedValue({
      sequence: 100n,
      value: "/ipfs/old",
    });

    await publishIPNS(fakeHelia, seed, cid, 42);

    // Should use 101n (existing + 1), not 42n
    expect(mockCreateIPNSRecord).toHaveBeenCalledWith(
      fakePrivKey,
      cid,
      101n,
      expect.any(Number),
    );
  });
});

describe("resolveIPNS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves via delegated routing first", async () => {
    const pubBytes = new Uint8Array(32).fill(2);
    const cid = await fakeCID("resolved");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockGetIPNS.mockResolvedValue({
      value: `/ipfs/${cid.toString()}`,
    });

    const result = await resolveIPNS(fakeHelia, pubBytes);

    expect(mockPublicKeyFromRaw).toHaveBeenCalledWith(pubBytes);
    expect(mockGetIPNS).toHaveBeenCalled();
    expect(result?.toString()).toBe(cid.toString());
    // Should NOT fall back to ipns().resolve
    expect(mockIpns).not.toHaveBeenCalled();
  });

  it("falls back to ipns().resolve when delegated fails", async () => {
    const pubBytes = new Uint8Array(32).fill(3);
    const cid = await fakeCID("fallback");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockGetIPNS.mockRejectedValue(new Error("not found"));
    mockResolve.mockResolvedValue({
      cid,
      path: "",
    });

    const result = await resolveIPNS(fakeHelia, pubBytes);

    expect(mockGetIPNS).toHaveBeenCalled();
    expect(mockIpns).toHaveBeenCalled();
    expect(result).toBe(cid);
  });

  it("falls back to DHT when no delegated routing", async () => {
    const pubBytes = new Uint8Array(32).fill(8);
    const cid = await fakeCID("dht-only");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockResolve.mockResolvedValue({ cid, path: "" });

    const noDelegatedHelia = {
      fake: "helia",
      libp2p: { services: {} },
    } as any;

    const result = await resolveIPNS(noDelegatedHelia, pubBytes);

    // Should skip delegated and go straight to DHT
    expect(mockGetIPNS).not.toHaveBeenCalled();
    expect(mockIpns).toHaveBeenCalled();
    expect(result).toBe(cid);
  });

  it("returns null on total failure", async () => {
    const pubBytes = new Uint8Array(32).fill(4);
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockGetIPNS.mockRejectedValue(new Error("not found"));
    mockResolve.mockRejectedValue(new Error("not found"));

    const result = await resolveIPNS(fakeHelia, pubBytes);

    expect(result).toBeNull();
  });
});

describe("watchIPNS", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIpns.mockReturnValue({ resolve: mockResolve });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onUpdate when CID changes", async () => {
    const pubBytes = new Uint8Array(32).fill(5);
    const cid1 = await fakeCID("v1");
    const cid2 = await fakeCID("v2");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);

    let resolveCount = 0;
    mockGetIPNS.mockImplementation(async () => {
      resolveCount++;
      if (resolveCount <= 2) {
        return { value: `/ipfs/${cid1.toString()}` };
      }
      return { value: `/ipfs/${cid2.toString()}` };
    });

    const onUpdate = vi.fn();
    const stop = watchIPNS(fakeHelia, pubBytes, onUpdate, 100);

    // First poll fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].toString()).toBe(cid1.toString());

    // Second poll — same CID, no new call
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Third poll — CID changes
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1]![0].toString()).toBe(cid2.toString());

    stop();
  });

  it("stop() prevents further polling", async () => {
    const pubBytes = new Uint8Array(32).fill(6);
    const cid = await fakeCID("stop-test");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockGetIPNS.mockResolvedValue({
      value: `/ipfs/${cid.toString()}`,
    });

    const onUpdate = vi.fn();
    const stop = watchIPNS(fakeHelia, pubBytes, onUpdate, 100);

    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    stop();

    await vi.advanceTimersByTimeAsync(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("accepts options object and calls onPollStart", async () => {
    const pubBytes = new Uint8Array(32).fill(9);
    const cid = await fakeCID("poll-start");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);
    mockGetIPNS.mockResolvedValue({
      value: `/ipfs/${cid.toString()}`,
    });

    const onUpdate = vi.fn();
    const onPollStart = vi.fn();
    const stop = watchIPNS(fakeHelia, pubBytes, onUpdate, {
      intervalMs: 200,
      onPollStart,
    });

    // First poll fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(onPollStart).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Second poll at 200ms
    await vi.advanceTimersByTimeAsync(200);
    expect(onPollStart).toHaveBeenCalledTimes(2);
    // Same CID, no new onUpdate
    expect(onUpdate).toHaveBeenCalledTimes(1);

    stop();
  });

  it("ignores poll errors gracefully", async () => {
    const pubBytes = new Uint8Array(32).fill(7);
    const cid = await fakeCID("after-error");
    const fakePubKey = {
      type: "Ed25519",
      toMultihash: () => identity.digest(new Uint8Array([0, 1, 2])),
    };
    mockPublicKeyFromRaw.mockReturnValue(fakePubKey);

    let callCount = 0;
    mockGetIPNS.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network error");
      }
      return {
        value: `/ipfs/${cid.toString()}`,
      };
    });
    // Fallback also fails on first call
    mockResolve.mockRejectedValueOnce(new Error("fallback fail"));

    const onUpdate = vi.fn();
    const stop = watchIPNS(fakeHelia, pubBytes, onUpdate, 100);

    // First poll fails
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();

    // Second poll succeeds
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].toString()).toBe(cid.toString());

    stop();
  });
});
