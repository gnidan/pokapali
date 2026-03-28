import { describe, it, expect } from "vitest";
import { generateIdentityKeypair } from "@pokapali/crypto";
import { signEdit, verifyEdit } from "./sign-edit.js";

describe("signEdit / verifyEdit", () => {
  it("round-trip: sign then verify succeeds", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const sig = await signEdit(payload, kp);

    expect(sig.length).toBe(64);
    expect(await verifyEdit(payload, sig, kp.publicKey)).toBe(true);
  });

  it("rejects tampered payload", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([10, 20, 30]);
    const sig = await signEdit(payload, kp);

    const tampered = new Uint8Array([10, 20, 31]);
    expect(await verifyEdit(tampered, sig, kp.publicKey)).toBe(false);
  });

  it("rejects wrong public key", async () => {
    const kp1 = await generateIdentityKeypair();
    const kp2 = await generateIdentityKeypair();
    const payload = new Uint8Array([5, 6, 7]);
    const sig = await signEdit(payload, kp1);

    expect(await verifyEdit(payload, sig, kp2.publicKey)).toBe(false);
  });

  it("empty signature returns false (backward compat)", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([1]);
    const emptySig = new Uint8Array();

    expect(await verifyEdit(payload, emptySig, kp.publicKey)).toBe(false);
  });
});
