import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { fetchBlock } from "./fetch-block.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

async function fakeCid(): Promise<CID> {
  const hash = await sha256.digest(
    new Uint8Array([1, 2, 3]),
  );
  return CID.createV1(0x71, hash);
}

describe("fetchBlock", () => {
  it("returns block on first try", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn().mockResolvedValue(block),
    };
    const result = await fetchBlock(
      { blockstore },
      cid,
    );
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure", async () => {
    const block = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid();
    const blockstore = {
      get: vi.fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(block),
    };
    const result = await fetchBlock(
      { blockstore },
      cid,
      { retries: 2, baseMs: 1, timeoutMs: 5000 },
    );
    expect(result).toBe(block);
    expect(blockstore.get).toHaveBeenCalledTimes(2);
  });

  it(
    "throws after exhausting retries",
    async () => {
      const cid = await fakeCid();
      const blockstore = {
        get: vi.fn().mockRejectedValue(
          new Error("gone"),
        ),
      };
      await expect(
        fetchBlock(
          { blockstore },
          cid,
          { retries: 1, baseMs: 1, timeoutMs: 5000 },
        ),
      ).rejects.toThrow("gone");
    },
  );

  describe("timeout / abort", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it(
      "passes abort signal to blockstore.get",
      async () => {
        const cid = await fakeCid();
        let capturedSignal: AbortSignal | undefined;
        const blockstore = {
          get: vi.fn(
            (
              _cid: CID,
              opts?: { signal?: AbortSignal },
            ) => {
              capturedSignal = opts?.signal;
              return Promise.reject(
                new Error("slow"),
              );
            },
          ),
        };

        await expect(
          fetchBlock(
            { blockstore },
            cid,
            {
              retries: 0,
              baseMs: 1,
              timeoutMs: 100,
            },
          ),
        ).rejects.toThrow("slow");

        expect(capturedSignal).toBeDefined();
        expect(
          capturedSignal instanceof AbortSignal,
        ).toBe(true);
      },
    );

    it(
      "signal is not yet aborted when get starts",
      async () => {
        const cid = await fakeCid();
        let signalAborted: boolean | undefined;
        const blockstore = {
          get: vi.fn(
            (
              _cid: CID,
              opts?: { signal?: AbortSignal },
            ) => {
              signalAborted =
                opts?.signal?.aborted;
              return Promise.resolve(
                new Uint8Array([1]),
              );
            },
          ),
        };

        await fetchBlock(
          { blockstore },
          cid,
          {
            retries: 0,
            baseMs: 1,
            timeoutMs: 100,
          },
        );

        expect(signalAborted).toBe(false);
      },
    );

    it(
      "clears timeout on successful fetch",
      async () => {
        const cid = await fakeCid();
        const block = new Uint8Array([1, 2, 3]);
        const blockstore = {
          get: vi.fn().mockResolvedValue(block),
        };

        const result = await fetchBlock(
          { blockstore },
          cid,
          {
            retries: 0,
            baseMs: 1,
            timeoutMs: 100,
          },
        );

        expect(result).toBe(block);
        // Advance past timeout to confirm no
        // lingering timer side effects
        await vi.advanceTimersByTimeAsync(200);
      },
    );

    it(
      "retries after failure with backoff delay",
      async () => {
        const cid = await fakeCid();
        const block = new Uint8Array([4, 5, 6]);
        const blockstore = {
          get: vi.fn()
            .mockRejectedValueOnce(
              new Error("timeout"),
            )
            .mockResolvedValue(block),
        };

        const promise = fetchBlock(
          { blockstore },
          cid,
          {
            retries: 1,
            baseMs: 50,
            timeoutMs: 5000,
          },
        );

        // Backoff delay: 50ms * 2^0 = 50ms
        await vi.advanceTimersByTimeAsync(50);

        const result = await promise;
        expect(result).toBe(block);
        expect(blockstore.get).toHaveBeenCalledTimes(
          2,
        );
      },
    );
  });
});
