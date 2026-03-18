import { describe, it, expect } from "vitest";
import {
  generateAdminSecret,
  generateIdentityKeypair,
  deriveDocKeys,
  deriveMetaRoomPassword,
  encryptSubdoc,
  decryptSubdoc,
  ed25519KeyPairFromSeed,
  signBytes,
  verifyBytes,
  hexToBytes,
  bytesToHex,
} from "./index.js";

function base64urlDecode(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

describe("generateAdminSecret", () => {
  it("returns base64url string of 32 bytes", () => {
    const secret = generateAdminSecret();
    expect(typeof secret).toBe("string");
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = base64urlDecode(secret);
    expect(decoded.length).toBe(32);
  });

  it("produces different values each call", () => {
    const a = generateAdminSecret();
    const b = generateAdminSecret();
    expect(a).not.toBe(b);
  });
});

describe("deriveDocKeys", () => {
  const adminSecret = "test-secret-1234";
  const appId = "test-app";
  const channels = ["content", "comments"];

  it("returns correct types and lengths", async () => {
    const keys = await deriveDocKeys(adminSecret, appId, channels);
    expect(keys.readKey).toBeInstanceOf(CryptoKey);
    expect(keys.ipnsKeyBytes).toBeInstanceOf(Uint8Array);
    expect(keys.ipnsKeyBytes.length).toBe(32);
    expect(keys.rotationKey).toBeInstanceOf(Uint8Array);
    expect(keys.rotationKey.length).toBe(32);
    expect(typeof keys.awarenessRoomPassword).toBe("string");
    expect(keys.awarenessRoomPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(keys.channelKeys).sort()).toEqual([
      "comments",
      "content",
    ]);
    for (const ch of channels) {
      expect(keys.channelKeys[ch]!.length).toBe(32);
    }
  });

  it("is deterministic", async () => {
    const a = await deriveDocKeys(adminSecret, appId, channels);
    const b = await deriveDocKeys(adminSecret, appId, channels);
    const aRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", a.readKey),
    );
    const bRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", b.readKey),
    );
    expect(arraysEqual(aRaw, bRaw)).toBe(true);
    expect(arraysEqual(a.ipnsKeyBytes, b.ipnsKeyBytes)).toBe(true);
    expect(arraysEqual(a.rotationKey, b.rotationKey)).toBe(true);
    expect(a.awarenessRoomPassword).toBe(b.awarenessRoomPassword);
    for (const ch of channels) {
      expect(arraysEqual(a.channelKeys[ch]!, b.channelKeys[ch]!)).toBe(true);
    }
  });

  it("works with empty appId", async () => {
    const keys = await deriveDocKeys(adminSecret, "", channels);
    expect(keys.readKey).toBeInstanceOf(CryptoKey);
    expect(keys.ipnsKeyBytes.length).toBe(32);
  });

  it("works with unicode appId", async () => {
    const keys = await deriveDocKeys(adminSecret, "日本語アプリ", channels);
    expect(keys.readKey).toBeInstanceOf(CryptoKey);
    expect(keys.ipnsKeyBytes.length).toBe(32);
  });
});

describe("deriveMetaRoomPassword", () => {
  it("returns a deterministic hex string", async () => {
    const keys = await deriveDocKeys("test-secret-1234", "test-app", [
      "primary",
    ]);
    const chKey = keys.channelKeys["primary"]!;

    const a = await deriveMetaRoomPassword(chKey);
    const b = await deriveMetaRoomPassword(chKey);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs from the channel key hex", async () => {
    const keys = await deriveDocKeys("test-secret-1234", "test-app", [
      "primary",
    ]);
    const chKey = keys.channelKeys["primary"]!;
    const chHex = Array.from(chKey, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    const password = await deriveMetaRoomPassword(chKey);
    expect(password).not.toBe(chHex);
  });
});

describe("encryptSubdoc / decryptSubdoc", () => {
  async function makeKey(): Promise<CryptoKey> {
    const keys = await deriveDocKeys("test-secret", "app", []);
    return keys.readKey;
  }

  it("round-trips data correctly", async () => {
    const key = await makeKey();
    const data = new TextEncoder().encode("hello world");
    const encrypted = await encryptSubdoc(key, data);
    const decrypted = await decryptSubdoc(key, encrypted);
    expect(arraysEqual(decrypted, data)).toBe(true);
  });

  it("produces deterministic output with explicit nonce", async () => {
    const key = await makeKey();
    const data = new TextEncoder().encode("deterministic");
    const nonce = new Uint8Array(12).fill(42);
    const a = await encryptSubdoc(key, data, nonce);
    const b = await encryptSubdoc(key, data, nonce);
    expect(arraysEqual(a, b)).toBe(true);
  });

  it("throws on decrypt with wrong key", async () => {
    const key1 = (await deriveDocKeys("secret-1", "app", [])).readKey;
    const key2 = (await deriveDocKeys("secret-2", "app", [])).readKey;
    const data = new TextEncoder().encode("secret data");
    const encrypted = await encryptSubdoc(key1, data);
    await expect(decryptSubdoc(key2, encrypted)).rejects.toThrow(
      /wrong key or corrupted data/,
    );
  });
});

describe("Ed25519", () => {
  const seed = new Uint8Array(32);
  seed.set([1, 2, 3, 4, 5]);

  it("keypair from seed is deterministic", async () => {
    const a = await ed25519KeyPairFromSeed(seed);
    const b = await ed25519KeyPairFromSeed(seed);
    expect(a.publicKey.length).toBe(32);
    expect(a.privateKey.length).toBe(32);
    expect(arraysEqual(a.publicKey, b.publicKey)).toBe(true);
  });

  it("sign/verify round-trip", async () => {
    const kp = await ed25519KeyPairFromSeed(seed);
    const data = new TextEncoder().encode("sign me");
    const sig = await signBytes(kp, data);
    const valid = await verifyBytes(kp.publicKey, sig, data);
    expect(valid).toBe(true);
  });

  it("verify with wrong key returns false", async () => {
    const kp = await ed25519KeyPairFromSeed(seed);
    const otherSeed = new Uint8Array(32).fill(99);
    const otherKp = await ed25519KeyPairFromSeed(otherSeed);
    const data = new TextEncoder().encode("sign me");
    const sig = await signBytes(kp, data);
    const valid = await verifyBytes(otherKp.publicKey, sig, data);
    expect(valid).toBe(false);
  });

  it("verify with malformed input returns false", async () => {
    const truncatedKey = new Uint8Array(16);
    const badSig = new Uint8Array(32);
    const data = new TextEncoder().encode("test");
    const valid = await verifyBytes(truncatedKey, badSig, data);
    expect(valid).toBe(false);
  });

  it("verify with tampered data returns false", async () => {
    const kp = await ed25519KeyPairFromSeed(seed);
    const data = new TextEncoder().encode("original");
    const sig = await signBytes(kp, data);
    const tampered = new TextEncoder().encode("tampered");
    const valid = await verifyBytes(kp.publicKey, sig, tampered);
    expect(valid).toBe(false);
  });
});

describe("generateIdentityKeypair", () => {
  it("returns a valid Ed25519 keypair", async () => {
    const kp = await generateIdentityKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("produces different keypairs each call", async () => {
    const a = await generateIdentityKeypair();
    const b = await generateIdentityKeypair();
    expect(arraysEqual(a.publicKey, b.publicKey)).toBe(false);
  });

  it("keypair can sign and verify", async () => {
    const kp = await generateIdentityKeypair();
    const data = new TextEncoder().encode("identity test");
    const sig = await signBytes(kp, data);
    const valid = await verifyBytes(kp.publicKey, sig, data);
    expect(valid).toBe(true);
  });
});

describe("hexToBytes / bytesToHex", () => {
  it("round-trips valid hex", () => {
    const bytes = new Uint8Array([0, 1, 127, 255]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("00017fff");
    const back = hexToBytes(hex);
    expect(arraysEqual(back, bytes)).toBe(true);
  });

  it("handles empty string", () => {
    const bytes = hexToBytes("");
    expect(bytes.length).toBe(0);
  });

  it("throws on odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow("odd-length");
  });

  it("throws on invalid hex characters", () => {
    expect(() => hexToBytes("zz")).toThrow("invalid hex");
    expect(() => hexToBytes("0g")).toThrow("invalid hex");
  });

  it("accepts uppercase hex", () => {
    const bytes = hexToBytes("FF00AB");
    expect(bytes).toEqual(new Uint8Array([255, 0, 171]));
  });
});
