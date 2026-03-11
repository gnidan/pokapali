import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchBlock } from "./fetch-block.js";
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
      expect(mockFetch.mock.calls[0][0]).toBe(
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
