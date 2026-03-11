import { describe, it, expect, vi, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { fetchVersionHistory } from "./fetch-version-history.js";
import type { VersionEntry } from "./fetch-version-history.js";

async function fakeCid(n: number): Promise<CID> {
  const bytes = new TextEncoder().encode(`block-${n}`);
  const hash = await sha256.digest(bytes);
  return CID.createV1(0x71, hash);
}

describe("fetchVersionHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns entries from pinner HTTP endpoint", async () => {
    const cid1 = await fakeCid(1);
    const cid2 = await fakeCid(2);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { cid: cid2.toString(), seq: 2, ts: 2000 },
          { cid: cid1.toString(), seq: 1, ts: 1000 },
        ],
      }),
    );

    const local = vi.fn();
    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      local,
    );

    expect(result).toHaveLength(2);
    expect(result[0].cid.toString()).toBe(cid2.toString());
    expect(result[0].seq).toBe(2);
    expect(result[0].ts).toBe(2000);
    expect(result[1].cid.toString()).toBe(cid1.toString());
    expect(local).not.toHaveBeenCalled();
  });

  it("falls back to local history on HTTP error", async () => {
    const cid = await fakeCid(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const localEntries: VersionEntry[] = [{ cid, seq: 1, ts: 1000 }];
    const local = vi.fn().mockResolvedValue(localEntries);

    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      local,
    );

    expect(result).toHaveLength(1);
    expect(result[0].cid.toString()).toBe(cid.toString());
    expect(local).toHaveBeenCalled();
  });

  it("falls back to local on fetch exception", async () => {
    const cid = await fakeCid(1);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    const local = vi.fn().mockResolvedValue([{ cid, seq: 1, ts: 1000 }]);

    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      local,
    );

    expect(result).toHaveLength(1);
    expect(local).toHaveBeenCalled();
  });

  it("returns [] when no pinners and local fails", async () => {
    const local = vi.fn().mockRejectedValue(new Error("no blocks"));

    const result = await fetchVersionHistory([], "abc123", local);

    expect(result).toEqual([]);
  });

  it("skips malformed entries", async () => {
    const cid = await fakeCid(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { cid: cid.toString(), seq: 1, ts: 1000 },
          { cid: 123, ts: 2000 }, // bad cid type
          { cid: "not-a-cid", seq: 2, ts: 3000 }, // unparseable
          { ts: 4000 }, // missing cid
        ],
      }),
    );

    const local = vi.fn();
    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      local,
    );

    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("tries next pinner on failure", async () => {
    const cid = await fakeCid(1);

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ cid: cid.toString(), seq: 1, ts: 1000 }],
      });
    vi.stubGlobal("fetch", fetchMock);

    const local = vi.fn();
    const result = await fetchVersionHistory(
      ["https://pinner1.example.com", "https://pinner2.example.com"],
      "abc123",
      local,
    );

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(local).not.toHaveBeenCalled();
  });

  it("defaults missing seq to 0", async () => {
    const cid = await fakeCid(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ cid: cid.toString(), ts: 1000 }],
      }),
    );

    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      vi.fn(),
    );

    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(0);
  });

  it("handles empty array from pinner", async () => {
    const cid = await fakeCid(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );

    const local = vi.fn().mockResolvedValue([{ cid, seq: 1, ts: 1000 }]);

    const result = await fetchVersionHistory(
      ["https://pinner.example.com"],
      "abc123",
      local,
    );

    // Empty pinner result → falls through to local
    expect(result).toHaveLength(1);
    expect(local).toHaveBeenCalled();
  });
});
