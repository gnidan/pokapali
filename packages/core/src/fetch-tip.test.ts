import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// Generate a real CID for testing
async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(0x55, hash);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

const { fetchTipFromPinners } = await import("./fetch-tip.js");

describe("fetchTipFromPinners", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns tip on successful fetch", async () => {
    const block = new Uint8Array([1, 2, 3, 4]);
    const cid = await makeCid(block);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        peerId: "12D3KooW-pinner1",
        seq: 5,
        ts: 1710000000000,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );

    expect(result).not.toBeNull();
    expect(result!.cid.equals(cid)).toBe(true);
    expect(result!.block).toEqual(block);
    expect(result!.seq).toBe(5);
    expect(result!.ts).toBe(1710000000000);
    expect(result!.peerId).toBe("12D3KooW-pinner1");

    // Verify URL construction
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://pinner1.example.com/tip/abc123",
      expect.any(Object),
    );
  });

  it("returns null on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("returns null for empty URLs", async () => {
    const result = await fetchTipFromPinners([], "abc123");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips malformed response " + "(missing cid)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        block: "AQID",
        peerId: "12D3KooW-p1",
        seq: 1,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("skips malformed response " + "(missing block)", async () => {
    const cid = await makeCid(new Uint8Array([1, 2]));
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        peerId: "12D3KooW-p1",
        seq: 1,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("skips malformed response " + "(missing peerId)", async () => {
    const block = new Uint8Array([1, 2]);
    const cid = await makeCid(block);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        seq: 1,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("skips unparseable CID", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: "not-a-valid-cid",
        block: "AQID",
        peerId: "12D3KooW-p1",
        seq: 1,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com"],
      "abc123",
    );
    expect(result).toBeNull();
  });

  it("tries next URL on failure", async () => {
    const block = new Uint8Array([10, 20]);
    const cid = await makeCid(block);

    // First URL fails
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });
    // Second URL succeeds
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        peerId: "12D3KooW-p2",
        seq: 3,
        ts: 1000,
      }),
    });

    const result = await fetchTipFromPinners(
      ["https://pinner1.example.com", "https://pinner2.example.com"],
      "abc123",
    );

    expect(result).not.toBeNull();
    expect(result!.seq).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults seq to 0 and ts to ~now " + "when missing", async () => {
    const block = new Uint8Array([5, 6]);
    const cid = await makeCid(block);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        peerId: "12D3KooW-p1",
      }),
    });

    const before = Date.now();
    const result = await fetchTipFromPinners(["https://p.example.com"], "abc");

    expect(result!.seq).toBe(0);
    expect(result!.ts).toBeGreaterThanOrEqual(before);
  });

  it("includes guarantee fields " + "when present", async () => {
    const block = new Uint8Array([7]);
    const cid = await makeCid(block);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        peerId: "12D3KooW-pinner-a",
        seq: 1,
        ts: 1000,
        guaranteeUntil: 9999,
        retainUntil: 8888,
      }),
    });

    const result = await fetchTipFromPinners(["https://p.example.com"], "abc");
    expect(result).not.toBeNull();
    expect(result!.peerId).toBe("12D3KooW-pinner-a");
    expect(result!.guaranteeUntil).toBe(9999);
    expect(result!.retainUntil).toBe(8888);
  });

  it("omits guarantee fields " + "when not in response", async () => {
    const block = new Uint8Array([8]);
    const cid = await makeCid(block);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cid: cid.toString(),
        block: uint8ToBase64(block),
        peerId: "12D3KooW-p1",
        seq: 1,
        ts: 1000,
      }),
    });

    const result = await fetchTipFromPinners(["https://p.example.com"], "abc");
    expect(result).not.toBeNull();
    expect(result!.guaranteeUntil).toBeUndefined();
    expect(result!.retainUntil).toBeUndefined();
  });

  it("respects abort signal", async () => {
    const ac = new AbortController();
    ac.abort();

    fetchSpy.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    const result = await fetchTipFromPinners(
      ["https://p.example.com"],
      "abc",
      ac.signal,
    );
    expect(result).toBeNull();
  });
});
