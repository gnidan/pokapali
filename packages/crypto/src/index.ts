export function generateAdminSecret(): string {
  throw new Error("not implemented");
}

export interface DocKeys {
  readKey: CryptoKey;
  ipnsKeyBytes: Uint8Array;
  rotationKey: Uint8Array;
  namespaceKeys: Record<string, Uint8Array>;
  awarenessRoomPassword: string;
}

export function deriveDocKeys(
  adminSecret: string,
  appId: string,
  namespaces: string[]
): Promise<DocKeys> {
  throw new Error("not implemented");
}

export function deriveMetaRoomPassword(
  primaryAccessKey: Uint8Array
): Promise<string> {
  throw new Error("not implemented");
}

export function encryptSubdoc(
  readKey: CryptoKey,
  data: Uint8Array,
  nonce?: Uint8Array
): Promise<Uint8Array> {
  throw new Error("not implemented");
}

export function decryptSubdoc(
  readKey: CryptoKey,
  encrypted: Uint8Array
): Promise<Uint8Array> {
  throw new Error("not implemented");
}

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function ed25519KeyPairFromSeed(
  seed: Uint8Array
): Promise<Ed25519KeyPair> {
  throw new Error("not implemented");
}

export function signBytes(
  keypair: Ed25519KeyPair,
  data: Uint8Array
): Promise<Uint8Array> {
  throw new Error("not implemented");
}

export function verifySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  throw new Error("not implemented");
}
