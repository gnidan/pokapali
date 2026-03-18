/**
 * Property-based tests for @pokapali/crypto.
 *
 * Verifies round-trip, format, and determinism
 * invariants for codec and cryptographic functions.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  bytesToHex,
  hexToBytes,
  base64urlEncode,
  encryptSubdoc,
  decryptSubdoc,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  signBytes,
  verifyBytes,
  generateAdminSecret,
} from "./index.js";

// ------------------------------------------------
// bytesToHex / hexToBytes
// ------------------------------------------------

describe("bytesToHex / hexToBytes properties", () => {
  it("round-trip: hexToBytes(bytesToHex(b)) ≡ b", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
        const hex = bytesToHex(bytes);
        const result = hexToBytes(hex);
        expect(result).toEqual(bytes);
      }),
      { numRuns: 200 },
    );
  });

  it("output is always lowercase hex of even length", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
        const hex = bytesToHex(bytes);
        expect(hex.length).toBe(bytes.length * 2);
        expect(hex).toMatch(/^[0-9a-f]*$/);
      }),
      { numRuns: 200 },
    );
  });

  it("hexToBytes rejects odd-length strings", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => s.length % 2 !== 0),
        (odd) => {
          expect(() => hexToBytes(odd)).toThrow("odd-length");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ------------------------------------------------
// base64urlEncode
// ------------------------------------------------

describe("base64urlEncode properties", () => {
  it("output matches base64url charset (no +/= chars)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
        const encoded = base64urlEncode(bytes);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      }),
      { numRuns: 200 },
    );
  });

  it("deterministic: same input → same output", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (bytes) => {
        expect(base64urlEncode(bytes)).toBe(base64urlEncode(bytes));
      }),
      { numRuns: 100 },
    );
  });
});

// ------------------------------------------------
// encrypt / decrypt round-trip
// ------------------------------------------------

describe("encryptSubdoc / decryptSubdoc properties", () => {
  it("round-trip: decrypt(encrypt(data)) ≡ data", async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", []);

    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        async (plaintext) => {
          const encrypted = await encryptSubdoc(keys.readKey, plaintext);
          const decrypted = await decryptSubdoc(keys.readKey, encrypted);
          expect(decrypted).toEqual(plaintext);
        },
      ),
      { numRuns: 50 },
    );
  });

  it(
    "encrypted output is always 12 + plaintext.length" +
      " + 16 bytes (IV + ciphertext + tag)",
    async () => {
      const secret = generateAdminSecret();
      const keys = await deriveDocKeys(secret, "test", []);

      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 256 }),
          async (plaintext) => {
            const encrypted = await encryptSubdoc(keys.readKey, plaintext);
            // AES-GCM: 12-byte IV + plaintext + 16-byte tag
            expect(encrypted.length).toBe(12 + plaintext.length + 16);
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it("wrong key fails decryption", async () => {
    const keys1 = await deriveDocKeys(generateAdminSecret(), "a", []);
    const keys2 = await deriveDocKeys(generateAdminSecret(), "b", []);

    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        async (plaintext) => {
          const encrypted = await encryptSubdoc(keys1.readKey, plaintext);
          await expect(
            decryptSubdoc(keys2.readKey, encrypted),
          ).rejects.toThrow();
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ------------------------------------------------
// sign / verify
// ------------------------------------------------

describe("signBytes / verifyBytes properties", () => {
  it("valid signature always verifies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        async (seed, data) => {
          const kp = await ed25519KeyPairFromSeed(seed);
          const sig = await signBytes(kp, data);
          const valid = await verifyBytes(kp.publicKey, sig, data);
          expect(valid).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("tampered data fails verification", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        async (seed, data) => {
          const kp = await ed25519KeyPairFromSeed(seed);
          const sig = await signBytes(kp, data);

          // Tamper: XOR first byte with 1
          // (guaranteed different)
          const tampered = new Uint8Array(data);
          tampered[0] = tampered[0]! ^ 1;

          const valid = await verifyBytes(kp.publicKey, sig, tampered);
          expect(valid).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("signature is deterministic for same seed + data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        async (seed, data) => {
          const kp = await ed25519KeyPairFromSeed(seed);
          const sig1 = await signBytes(kp, data);
          const sig2 = await signBytes(kp, data);
          expect(sig1).toEqual(sig2);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ------------------------------------------------
// deriveDocKeys determinism
// ------------------------------------------------

describe("deriveDocKeys properties", () => {
  it("deterministic: same inputs → same keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
          minLength: 0,
          maxLength: 3,
        }),
        async (appId, channels) => {
          const secret = generateAdminSecret();
          const k1 = await deriveDocKeys(secret, appId, channels);
          const k2 = await deriveDocKeys(secret, appId, channels);
          expect(k1.ipnsKeyBytes).toEqual(k2.ipnsKeyBytes);
          expect(k1.rotationKey).toEqual(k2.rotationKey);
          expect(k1.awarenessRoomPassword).toBe(k2.awarenessRoomPassword);
          for (const ch of channels) {
            expect(k1.channelKeys[ch]).toEqual(k2.channelKeys[ch]);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("key bytes are always 32 bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 3,
        }),
        async (channels) => {
          const secret = generateAdminSecret();
          const keys = await deriveDocKeys(secret, "app", channels);
          expect(keys.ipnsKeyBytes.length).toBe(32);
          expect(keys.rotationKey.length).toBe(32);
          for (const ch of channels) {
            expect(keys.channelKeys[ch]!.length).toBe(32);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
