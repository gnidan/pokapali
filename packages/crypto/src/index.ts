import * as ed25519 from "@noble/ed25519";

export function generateAdminSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export function base64urlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface DocKeys {
  readKey: CryptoKey;
  ipnsKeyBytes: Uint8Array;
  rotationKey: Uint8Array;
  channelKeys: Record<string, Uint8Array>;
  awarenessRoomPassword: string;
}

export async function deriveDocKeys(
  adminSecret: string,
  appId: string,
  channels: string[],
): Promise<DocKeys> {
  const raw = new TextEncoder().encode(adminSecret);
  const baseKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);

  const makeInfo = (purpose: string) =>
    new TextEncoder().encode(`${appId}:${purpose}`);

  const deriveAES = (purpose: string) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: makeInfo(purpose),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

  const deriveBits = async (purpose: string) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: makeInfo(purpose),
        },
        baseKey,
        256,
      ),
    );

  const readKey = await deriveAES("read");
  const ipnsKeyBytes = await deriveBits("ipns");
  const rotationKey = await deriveBits("rotation");
  const awarenessRoomBytes = await deriveBits("awareness-room");
  const awarenessRoomPassword = bytesToHex(awarenessRoomBytes);

  const channelKeys: Record<string, Uint8Array> = Object.fromEntries(
    await Promise.all(
      channels.map(async (ch) => [ch, await deriveBits(`ns:${ch}`)]),
    ),
  );

  return {
    readKey,
    ipnsKeyBytes,
    rotationKey,
    channelKeys,
    awarenessRoomPassword,
  };
}

export async function deriveMetaRoomPassword(
  primaryAccessKey: Uint8Array,
): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    primaryAccessKey as unknown as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("_meta_room"),
    },
    baseKey,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function encryptSubdoc(
  readKey: CryptoKey,
  data: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as ArrayBuffer,
    },
    readKey,
    data as unknown as ArrayBuffer,
  );
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

export async function decryptSubdoc(
  readKey: CryptoKey,
  encrypted: Uint8Array,
): Promise<Uint8Array> {
  const iv = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as ArrayBuffer,
      },
      readKey,
      ciphertext as unknown as ArrayBuffer,
    );
    return new Uint8Array(plaintext);
  } catch (err) {
    throw new Error("decryptSubdoc failed: wrong key or" + " corrupted data", {
      cause: err,
    });
  }
}

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generate a random Ed25519 identity keypair.
 * Device-generated, not derived from a doc secret.
 */
export async function generateIdentityKeypair(): Promise<Ed25519KeyPair> {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return ed25519KeyPairFromSeed(seed);
}

export async function ed25519KeyPairFromSeed(
  seed: Uint8Array,
): Promise<Ed25519KeyPair> {
  const publicKey = await ed25519.getPublicKeyAsync(seed);
  return { publicKey, privateKey: seed };
}

export async function signBytes(
  keypair: Ed25519KeyPair,
  data: Uint8Array,
): Promise<Uint8Array> {
  return ed25519.signAsync(data, keypair.privateKey);
}

export async function verifySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    return await ed25519.verifyAsync(signature, data, publicKey);
  } catch {
    return false;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hexToBytes: odd-length hex string");
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexToBytes: invalid hex characters");
  }
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
