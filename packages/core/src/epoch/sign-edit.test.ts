import { describe, it, expect } from "vitest";
import { generateIdentityKeypair, bytesToHex } from "@pokapali/crypto";
import {
  signEdit,
  verifyEdit,
  ENVELOPE_VERSION,
  HEADER_SIZE,
} from "./sign-edit.js";

describe("signEdit / verifyEdit", () => {
  it("round-trip: sign then verify succeeds", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const envelope = await signEdit(payload, kp);

    expect(envelope.length).toBe(HEADER_SIZE + 4);
    expect(envelope[0]).toBe(ENVELOPE_VERSION);

    const result = await verifyEdit(envelope);
    expect(result).not.toBeNull();
    expect(result!.payload).toEqual(payload);
    expect(result!.pubkey).toEqual(kp.publicKey);
  });

  it("envelope embeds pubkey at offset 1", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([10]);
    const envelope = await signEdit(payload, kp);

    const embedded = envelope.slice(1, 33);
    expect(embedded).toEqual(kp.publicKey);
  });

  it("rejects tampered payload", async () => {
    const kp = await generateIdentityKeypair();
    const payload = new Uint8Array([10, 20, 30]);
    const envelope = await signEdit(payload, kp);

    // Flip last byte of the payload region
    const tampered = new Uint8Array(envelope);
    tampered[tampered.length - 1]! ^= 0xff;

    expect(await verifyEdit(tampered)).toBeNull();
  });

  it("rejects tampered signature", async () => {
    const kp = await generateIdentityKeypair();
    const envelope = await signEdit(new Uint8Array([5, 6, 7]), kp);

    const tampered = new Uint8Array(envelope);
    tampered[33]! ^= 0xff; // flip first sig byte
    expect(await verifyEdit(tampered)).toBeNull();
  });

  it("rejects envelope shorter than header", async () => {
    const short = new Uint8Array(HEADER_SIZE - 1);
    short[0] = ENVELOPE_VERSION;
    expect(await verifyEdit(short)).toBeNull();
  });

  it("rejects unknown version byte", async () => {
    const kp = await generateIdentityKeypair();
    const envelope = await signEdit(new Uint8Array([1]), kp);
    const bad = new Uint8Array(envelope);
    bad[0] = 0xff;
    expect(await verifyEdit(bad)).toBeNull();
  });

  it("rejects empty envelope", async () => {
    expect(await verifyEdit(new Uint8Array())).toBeNull();
  });

  describe("trusted key set", () => {
    it("accepts edit from trusted signer", async () => {
      const kp = await generateIdentityKeypair();
      const hex = bytesToHex(kp.publicKey);
      const envelope = await signEdit(new Uint8Array([1, 2]), kp);

      const result = await verifyEdit(envelope, new Set([hex]));
      expect(result).not.toBeNull();
      expect(result!.payload).toEqual(new Uint8Array([1, 2]));
    });

    it("rejects edit from untrusted signer", async () => {
      const kp = await generateIdentityKeypair();
      const other = await generateIdentityKeypair();
      const envelope = await signEdit(new Uint8Array([3, 4]), kp);

      const trusted = new Set([bytesToHex(other.publicKey)]);
      expect(await verifyEdit(envelope, trusted)).toBeNull();
    });

    it("empty trusted set is permissionless", async () => {
      const kp = await generateIdentityKeypair();
      const envelope = await signEdit(new Uint8Array([5]), kp);
      const result = await verifyEdit(envelope, new Set());
      expect(result).not.toBeNull();
    });

    it("undefined trusted set is permissionless", async () => {
      const kp = await generateIdentityKeypair();
      const envelope = await signEdit(new Uint8Array([6]), kp);
      expect(await verifyEdit(envelope, undefined)).not.toBeNull();
    });
  });

  it("empty payload round-trips", async () => {
    const kp = await generateIdentityKeypair();
    const envelope = await signEdit(new Uint8Array(), kp);
    expect(envelope.length).toBe(HEADER_SIZE);

    const result = await verifyEdit(envelope);
    expect(result).not.toBeNull();
    expect(result!.payload.length).toBe(0);
  });
});
