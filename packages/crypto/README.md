# @pokapali/crypto

> **This package is not published to npm.** It is under
> active development and not yet ready for production use.

Cryptographic primitives for Pokapali. Derives all document
keys from a single admin secret via HKDF (RFC 5869), with
the `appId` baked into the `info` parameter to prevent
cross-app key collisions. Uses `@noble/ed25519` for signing
and the Web Crypto API for AES-GCM encryption.

## Key Exports

- **`generateAdminSecret()`** — generates a random
  base64url-encoded admin secret
- **`deriveDocKeys(secret, appId, namespaces)`** —
  derives all keys (readKey, ipnsKeyBytes, rotationKey,
  namespace keys, awarenessRoomPassword)
- **`DocKeys`** — interface for the full key set
- **`ed25519KeyPairFromSeed(seed)`** — Ed25519 keypair
  from a 32-byte seed
- **`signBytes(data, keyPair)`** / **`verifySignature(
  data, signature, publicKey)`** — Ed25519 sign/verify
- **`encryptSubdoc(data, readKey)`** /
  **`decryptSubdoc(ciphertext, readKey)`** — AES-GCM
  encrypt/decrypt
- **`bytesToHex(bytes)`** / **`hexToBytes(hex)`** —
  hex encoding utilities

## Links

- [Root README](../../README.md)
- [Architecture — Key Derivation](../../docs/architecture.md)
