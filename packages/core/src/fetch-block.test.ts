import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchBlock, ensureUint8Array } from "./fetch-block.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_CBOR_CODE = 0x71;

async function fakeCid(data = new Uint8Array([1, 2, 3])): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

describe("fetchBlock", () => {
  it("returns block on first try", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn().mockResolvedValue(block),
    };
    const result = await fetchBlock({ blockstore }, cid);
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(block),
    };
    const result = await fetchBlock({ blockstore }, cid, {
      retries: 2,
      baseMs: 1,
      timeoutMs: 5000,
    });
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn().mockRejectedValue(new Error("gone")),
    };
    await expect(
      fetchBlock({ blockstore }, cid, {
        retries: 1,
        baseMs: 1,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("gone");
  });

  // Regression: GH #60 — IDBBlockstore returns
  // ArrayBuffer. fetchBlock must normalize to
  // Uint8Array so downstream sha256.digest() and
  // other typed-array consumers don't break.
  describe("ArrayBuffer normalization (GH #60)", () => {
    it(
      "normalizes ArrayBuffer from blockstore" + " to Uint8Array",
      async () => {
        const data = new Uint8Array([10, 20, 30]);
        const cid = await fakeCid();
        // Simulate IDBBlockstore returning ArrayBuffer
        const arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );
        const blockstore = {
          get: vi.fn().mockResolvedValue(arrayBuffer),
        };
        const result = await fetchBlock({ blockstore }, cid);
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result).toEqual(data);
      },
    );

    it("returned Uint8Array works with " + "sha256.digest", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid();
      const arrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
      const blockstore = {
        get: vi.fn().mockResolvedValue(arrayBuffer),
      };
      const result = await fetchBlock({ blockstore }, cid);
      // This would throw "Unknown type, must be
      // binary type" if result is still ArrayBuffer
      const hash = await sha256.digest(result);
      expect(hash).toBeDefined();
    });
  });

  describe("HTTP fallback", () => {
    it("falls back to HTTP after blockstore" + " retries exhaust", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid(data);
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(data.buffer),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        httpUrls: ["https://relay.example.com"],
      });

      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]![0]).toBe(
        `https://relay.example.com/block/${cid.toString()}`,
      );

      vi.unstubAllGlobals();
    });

    it("rejects blocks with CID mismatch", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid(data);
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      // Return tampered data
      const tampered = new Uint8Array([99, 99, 99]);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(tampered.buffer),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchBlock({ blockstore }, cid, {
          retries: 0,
          baseMs: 1,
          httpUrls: ["https://relay.example.com"],
        }),
      ).rejects.toThrow("gone");

      vi.unstubAllGlobals();
    });

    it("tries next URL on HTTP failure", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid(data);
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(data.buffer),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        httpUrls: ["https://bad.example.com", "https://good.example.com"],
      });

      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });

    it("skips HTTP fallback when no URLs" + " provided", async () => {
      const cid = await fakeCid();
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      await expect(
        fetchBlock({ blockstore }, cid, {
          retries: 0,
          baseMs: 1,
        }),
      ).rejects.toThrow("gone");
    });

    it("throws original error when all HTTP" + " URLs fail", async () => {
      const cid = await fakeCid();
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("blockstore error")),
      };

      const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchBlock({ blockstore }, cid, {
          retries: 0,
          baseMs: 1,
          httpUrls: ["https://relay.example.com"],
        }),
      ).rejects.toThrow("blockstore error");

      vi.unstubAllGlobals();
    });

    it("treats 429 rate-limit as non-ok" + " and tries next URL", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid(data);
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
        })
        .mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(data.buffer),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        httpUrls: ["https://limited.example.com", "https://ok.example.com"],
      });

      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });

    it(
      "throws original error when all URLs" + " return CID mismatch",
      async () => {
        const data = new Uint8Array([10, 20, 30]);
        const cid = await fakeCid(data);
        const blockstore = {
          get: vi.fn().mockRejectedValue(new Error("blockstore fail")),
        };

        const tampered = new Uint8Array([99, 99, 99]);
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(tampered.buffer),
        });
        vi.stubGlobal("fetch", mockFetch);

        await expect(
          fetchBlock({ blockstore }, cid, {
            retries: 0,
            baseMs: 1,
            httpUrls: ["https://bad1.example.com", "https://bad2.example.com"],
          }),
        ).rejects.toThrow("blockstore fail");

        expect(mockFetch).toHaveBeenCalledTimes(2);

        vi.unstubAllGlobals();
      },
    );

    it("skips non-ok HTTP responses", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const cid = await fakeCid(data);
      const blockstore = {
        get: vi.fn().mockRejectedValue(new Error("gone")),
      };

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        })
        .mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(data.buffer),
        });
      vi.stubGlobal("fetch", mockFetch);

      const result = await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        httpUrls: [
          "https://no-block.example.com",
          "https://has-block.example.com",
        ],
      });

      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });
  });

  describe("timeout / abort", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("passes abort signal to blockstore.get", async () => {
      const cid = await fakeCid();
      let capturedSignal: AbortSignal | undefined;
      const blockstore = {
        get: vi.fn((_cid: CID, opts?: { signal?: AbortSignal }) => {
          capturedSignal = opts?.signal;
          return Promise.reject(new Error("slow"));
        }),
      };

      await expect(
        fetchBlock({ blockstore }, cid, {
          retries: 0,
          baseMs: 1,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("slow");

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal instanceof AbortSignal).toBe(true);
    });

    it("signal is not yet aborted when get starts", async () => {
      const cid = await fakeCid();
      let signalAborted: boolean | undefined;
      const blockstore = {
        get: vi.fn((_cid: CID, opts?: { signal?: AbortSignal }) => {
          signalAborted = opts?.signal?.aborted;
          return Promise.resolve(new Uint8Array([1]));
        }),
      };

      await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        timeoutMs: 100,
      });

      expect(signalAborted).toBe(false);
    });

    it("clears timeout on successful fetch", async () => {
      const cid = await fakeCid();
      const block = new Uint8Array([1, 2, 3]);
      const blockstore = {
        get: vi.fn().mockResolvedValue(block),
      };

      const result = await fetchBlock({ blockstore }, cid, {
        retries: 0,
        baseMs: 1,
        timeoutMs: 100,
      });

      expect(result).toBe(block);
      // Advance past timeout to confirm no
      // lingering timer side effects
      await vi.advanceTimersByTimeAsync(200);
    });

    it("retries after failure with backoff delay", async () => {
      const cid = await fakeCid();
      const block = new Uint8Array([4, 5, 6]);
      const blockstore = {
        get: vi
          .fn()
          .mockRejectedValueOnce(new Error("timeout"))
          .mockResolvedValue(block),
      };

      const promise = fetchBlock({ blockstore }, cid, {
        retries: 1,
        baseMs: 50,
        timeoutMs: 5000,
      });

      // Backoff delay: 50ms * 2^0 = 50ms
      await vi.advanceTimersByTimeAsync(50);

      const result = await promise;
      expect(result).toBe(block);
      expect(blockstore.get).toHaveBeenCalledTimes(2);
    });
  });
});

// Regression: GH #60 — ensureUint8Array utility
describe("ensureUint8Array", () => {
  it("returns plain Uint8Array unchanged", () => {
    const u8 = new Uint8Array([1, 2, 3]);
    const result = ensureUint8Array(u8);
    expect(result).toBe(u8);
  });

  it("converts ArrayBuffer to Uint8Array", () => {
    const u8 = new Uint8Array([4, 5, 6]);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const result = ensureUint8Array(ab);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.constructor).toBe(Uint8Array);
    expect(result).toEqual(u8);
  });

  it("converts Buffer to plain Uint8Array", () => {
    const buf = Buffer.from([7, 8, 9]);
    const result = ensureUint8Array(buf);
    expect(result).toBeInstanceOf(Uint8Array);
    // Buffer subclasses Uint8Array but
    // constructor !== Uint8Array
    expect(result.constructor).toBe(Uint8Array);
    expect(result).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("handles typed-array subclass view", () => {
    const ab = new ArrayBuffer(4);
    const view = new DataView(ab);
    view.setUint8(0, 10);
    view.setUint8(1, 20);
    view.setUint8(2, 30);
    view.setUint8(3, 40);
    const result = ensureUint8Array(view);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array([10, 20, 30, 40]));
  });

  it("handles Buffer subclass with non-zero " + "byteOffset", () => {
    const ab = new ArrayBuffer(10);
    const slice = new Uint8Array(ab, 3, 4);
    slice.set([1, 2, 3, 4]);
    // Create a Buffer-like subclass with offset
    const buf = Buffer.from(ab, slice.byteOffset, slice.byteLength);
    const result = ensureUint8Array(buf);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.length).toBe(4);
  });

  it("preserves data through sha256.digest", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const ab = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
    const result = ensureUint8Array(ab);
    // sha256.digest rejects ArrayBuffer but
    // accepts the converted Uint8Array
    const hash = await sha256.digest(result);
    expect(hash).toBeDefined();
  });
});
