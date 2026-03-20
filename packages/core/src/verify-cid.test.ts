import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { verifyCid } from "./verify-cid.js";

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(0x55, hash);
}

describe("verifyCid", () => {
  it("returns true for matching block", async () => {
    const block = new Uint8Array([1, 2, 3, 4]);
    const cid = await makeCid(block);
    expect(await verifyCid(cid, block)).toBe(true);
  });

  it("returns false for tampered block", async () => {
    const block = new Uint8Array([1, 2, 3, 4]);
    const cid = await makeCid(block);
    const tampered = new Uint8Array([5, 6, 7, 8]);
    expect(await verifyCid(cid, tampered)).toBe(false);
  });

  it("returns false for unsupported " + "hash algorithm", async () => {
    // Create a CID with a non-sha256 multihash
    // code (0x00 = identity)
    const block = new Uint8Array([1, 2]);
    const fakeMultihash = {
      code: 0x00,
      digest: block,
      bytes: new Uint8Array([0x00, 0x02, 1, 2]),
      size: 2,
    };
    const cid = CID.createV1(0x55, fakeMultihash);
    expect(await verifyCid(cid, block)).toBe(false);
  });

  it("returns true for empty block", async () => {
    const block = new Uint8Array([]);
    const cid = await makeCid(block);
    expect(await verifyCid(cid, block)).toBe(true);
  });
});
