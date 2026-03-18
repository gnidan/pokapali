# @pokapali/crypto

```sh
npm install @pokapali/crypto
```

Cryptographic primitives for Pokapali. Derives all document
keys from a single admin secret via HKDF (RFC 5869), with
the `appId` baked into the `info` parameter to prevent
cross-app key collisions. Uses `@noble/ed25519` for signing
and the Web Crypto API for AES-GCM encryption.

## Key Exports

- **`generateAdminSecret()`** — generates a random
  base64url-encoded admin secret
- **`deriveDocKeys(secret, appId, channels)`** —
  derives all keys (readKey, ipnsKeyBytes, rotationKey,
  channel keys, awarenessRoomPassword)
- **`DocKeys`** — interface for the full key set
- **`ed25519KeyPairFromSeed(seed)`** — Ed25519 keypair
  from a 32-byte seed
- **`signBytes(keyPair, data)`** / **`verifyBytes(
publicKey, signature, data)`** — Ed25519 sign/verify
- **`encryptSubdoc(readKey, data)`** /
  **`decryptSubdoc(readKey, ciphertext)`** — AES-GCM
  encrypt/decrypt
- **`bytesToHex(bytes)`** / **`hexToBytes(hex)`** —
  hex encoding utilities

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
- [Architecture — Key Derivation](https://github.com/gnidan/pokapali/tree/main/docs/internals)
