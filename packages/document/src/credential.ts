/**
 * Narrowed subset of document keys for sharing via
 * capability URLs. Fields are optional because lower
 * permission levels (e.g. read-only) omit keys that
 * grant write or admin access.
 */
export interface Credential {
  /** AES-GCM-256 key for encrypting/decrypting
   *  snapshots. Present at all permission levels. */
  readKey?: CryptoKey;
  /** Ed25519 private key bytes for IPNS publishing.
   *  Present for writers and admins. */
  ipnsKeyBytes?: Uint8Array;
  /** Key used for document rotation (re-keying).
   *  Present for admins only. */
  rotationKey?: Uint8Array;
  /** Shared password for the awareness (cursor/
   *  presence) room. */
  awarenessRoomPassword?: string;
  /** Per-channel symmetric keys, keyed by channel
   *  name. Writers receive keys for their permitted
   *  channels; admins derive all keys via HKDF. */
  channelKeys?: Record<string, Uint8Array>;
}
