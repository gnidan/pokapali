import { describe, it, expect, vi } from "vitest";
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
});
