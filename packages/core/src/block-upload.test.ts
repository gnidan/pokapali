import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { uploadBlock } from "./block-upload.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_CBOR_CODE = 0x71;

async function fakeCid(data = new Uint8Array([1, 2, 3])): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

describe("uploadBlock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uploads to the first responsive URL", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadBlock(cid, data, ["https://relay.example.com"]);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`https://relay.example.com/block/${cid.toString()}`);
    expect(opts.method).toBe("POST");
    expect(new Uint8Array(opts.body)).toEqual(data);
    expect(opts.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("tries next URL on failure", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadBlock(cid, data, [
      "https://bad.example.com",
      "https://good.example.com",
    ]);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("tries next URL on non-ok response", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadBlock(cid, data, [
      "https://busy.example.com",
      "https://ok.example.com",
    ]);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries with backoff when all URLs fail", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    // Fail 2 relays × 2 attempts, succeed on 3rd
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const p = uploadBlock(cid, data, [
      "https://a.example.com",
      "https://b.example.com",
    ]);

    // Attempt 0: 2 fetches, both fail
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Retry 1 after 1s delay
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Retry 2 after 2s delay — first fetch succeeds
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockFetch).toHaveBeenCalledTimes(5);

    const result = await p;
    expect(result).toBe(true);
  });

  it("returns false after exhausting retries", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", mockFetch);

    const p = uploadBlock(cid, data, ["https://bad.example.com"], {
      maxRetries: 2,
    });

    // Attempt 0
    await vi.advanceTimersByTimeAsync(0);
    // Retry 1 (1s delay)
    await vi.advanceTimersByTimeAsync(1_000);
    // Retry 2 (2s delay)
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await p;
    expect(result).toBe(false);
    // 1 URL × 3 attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("aborts retries on signal", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const ac = new AbortController();
    const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", mockFetch);

    const p = uploadBlock(cid, data, ["https://bad.example.com"], {
      signal: ac.signal,
    });

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Abort during retry delay
    ac.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await p;
    expect(result).toBe(false);
    // Should not have retried after abort
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns false when no URLs provided", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);

    const result = await uploadBlock(cid, data, []);

    expect(result).toBe(false);
  });
});
