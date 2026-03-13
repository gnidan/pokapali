import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadBlock } from "./block-upload.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_CBOR_CODE = 0x71;

async function fakeCid(data = new Uint8Array([1, 2, 3])): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(DAG_CBOR_CODE, hash);
}

describe("uploadBlock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads to the first responsive URL", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadBlock(cid, data, ["https://relay.example.com"]);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
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

  it("returns false when all URLs fail", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);
    const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadBlock(cid, data, [
      "https://bad1.example.com",
      "https://bad2.example.com",
    ]);

    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns false when no URLs provided", async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid = await fakeCid(data);

    const result = await uploadBlock(cid, data, []);

    expect(result).toBe(false);
  });
});
