import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import type { Ed25519KeyPair } from "@pokapali/crypto";
import {
  encryptSubdoc,
  decryptSubdoc,
  signBytes,
  verifyBytes,
} from "@pokapali/crypto";

export interface SnapshotNode {
  subdocs: Record<string, Uint8Array>;
  prev: CID | null;
  seq: number;
  ts: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
  /** Publisher's Ed25519 identity public key. */
  publisher?: Uint8Array;
  /** Publisher signs (publicKey, seq, ts). */
  publisherSig?: Uint8Array;
}

// The payload that gets signed (everything
// except the signature itself).
interface SignablePayload {
  subdocs: Record<string, Uint8Array>;
  prev: CID | null;
  seq: number;
  ts: number;
  publicKey: Uint8Array;
  publisher?: Uint8Array;
  publisherSig?: Uint8Array;
}

// What the publisher's identity key signs.
interface PublisherSignablePayload {
  publicKey: Uint8Array;
  seq: number;
  ts: number;
}

export async function encodeSnapshot(
  plaintextSubdocs: Record<string, Uint8Array>,
  readKey: CryptoKey,
  prev: CID | null,
  seq: number,
  ts: number,
  signingKey: Ed25519KeyPair,
  identityKey?: Ed25519KeyPair,
): Promise<Uint8Array> {
  // Encrypt each subdoc payload
  const subdocs: Record<string, Uint8Array> = {};
  for (const [ns, data] of Object.entries(plaintextSubdocs)) {
    subdocs[ns] = await encryptSubdoc(readKey, data);
  }

  const payload: SignablePayload = {
    subdocs,
    prev,
    seq,
    ts,
    publicKey: signingKey.publicKey,
  };

  // Publisher signs (publicKey, seq, ts) first
  if (identityKey) {
    const pubPayload: PublisherSignablePayload = {
      publicKey: signingKey.publicKey,
      seq,
      ts,
    };
    const pubBytes = dagCbor.encode(pubPayload);
    payload.publisher = identityKey.publicKey;
    payload.publisherSig = await signBytes(identityKey, pubBytes);
  }

  // Doc key signs the full payload (including
  // publisher/publisherSig if present)
  const payloadBytes = dagCbor.encode(payload);
  const signature = await signBytes(signingKey, payloadBytes);

  const node = { ...payload, signature };
  return dagCbor.encode(node);
}

export function decodeSnapshot(bytes: Uint8Array): SnapshotNode {
  const decoded = dagCbor.decode<SnapshotNode>(bytes);
  return decoded;
}

export async function decryptSnapshot(
  node: SnapshotNode,
  readKey: CryptoKey,
): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  for (const [ns, encrypted] of Object.entries(node.subdocs)) {
    result[ns] = await decryptSubdoc(readKey, encrypted);
  }
  return result;
}

export async function validateSnapshot(block: Uint8Array): Promise<boolean> {
  try {
    const node = decodeSnapshot(block);

    // Reconstruct the signable payload
    const payload: SignablePayload = {
      subdocs: node.subdocs,
      prev: node.prev,
      seq: node.seq,
      ts: node.ts,
      publicKey: node.publicKey,
    };

    // Include publisher fields in doc-sig payload
    // if present
    if (node.publisher) {
      // publisher without publisherSig is invalid —
      // reject unproven publisher claims
      if (!node.publisherSig) return false;
      payload.publisher = node.publisher;
      payload.publisherSig = node.publisherSig;
    }

    const payloadBytes = dagCbor.encode(payload);

    const docSigValid = await verifyBytes(
      node.publicKey,
      node.signature,
      payloadBytes,
    );
    if (!docSigValid) return false;

    // Verify publisher signature if present
    if (node.publisher && node.publisherSig) {
      const pubPayload: PublisherSignablePayload = {
        publicKey: node.publicKey,
        seq: node.seq,
        ts: node.ts,
      };
      const pubBytes = dagCbor.encode(pubPayload);
      const pubSigValid = await verifyBytes(
        node.publisher,
        node.publisherSig,
        pubBytes,
      );
      if (!pubSigValid) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export class ChainCycleError extends Error {
  override name = "ChainCycleError" as const;
  constructor(public readonly cid: string) {
    super(`Cycle detected in snapshot chain at ${cid}`);
  }
}

export class ChainDepthExceededError extends Error {
  override name = "ChainDepthExceededError" as const;
  constructor(public readonly maxDepth: number) {
    super(`Snapshot chain exceeded max depth of ${maxDepth}`);
  }
}

export const DEFAULT_MAX_CHAIN_DEPTH = 1000;

export interface WalkChainOptions {
  maxDepth?: number;
}

export async function* walkChain(
  tipCid: CID,
  blockGetter: (cid: CID) => Promise<Uint8Array>,
  options?: WalkChainOptions,
): AsyncGenerator<SnapshotNode> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  const visited = new Set<string>();
  let current: CID | null = tipCid;
  let depth = 0;

  while (current !== null) {
    const key = current.toString();
    if (visited.has(key)) {
      throw new ChainCycleError(key);
    }
    if (depth >= maxDepth) {
      throw new ChainDepthExceededError(maxDepth);
    }
    visited.add(key);
    const block = await blockGetter(current);
    const node = decodeSnapshot(block);
    yield node;
    current = node.prev;
    depth++;
  }
}

export { CID } from "multiformats/cid";
export { sha256 } from "multiformats/hashes/sha2";
export { code as dagCborCode } from "@ipld/dag-cbor";

// Pure state machine for fetch coalescing

/** @internal */
export interface FetchCoalescerState {
  pending: Set<string>;
  inflight: Set<string>;
  resolved: Map<string, Uint8Array>;
  failed: Set<string>;
}

/** @internal */
export function createFetchCoalescerState(): FetchCoalescerState {
  return {
    pending: new Set(),
    inflight: new Set(),
    resolved: new Map(),
    failed: new Set(),
  };
}

const COALESCER_CONCURRENCY = 3;

/** @internal */
export function coalescerNext(state: FetchCoalescerState): {
  toFetch: string[];
} {
  const toFetch: string[] = [];
  for (const cid of state.pending) {
    if (
      state.inflight.has(cid) ||
      state.resolved.has(cid) ||
      state.failed.has(cid)
    ) {
      continue;
    }
    toFetch.push(cid);
    if (toFetch.length >= COALESCER_CONCURRENCY) {
      break;
    }
  }
  for (const cid of toFetch) {
    state.pending.delete(cid);
    state.inflight.add(cid);
  }
  return { toFetch };
}

/** @internal */
export function coalescerResolve(
  state: FetchCoalescerState,
  cid: string,
  block: Uint8Array,
): FetchCoalescerState {
  state.inflight.delete(cid);
  state.resolved.set(cid, block);
  return state;
}

/** @internal */
export function coalescerFail(
  state: FetchCoalescerState,
  cid: string,
): FetchCoalescerState {
  state.inflight.delete(cid);
  state.failed.add(cid);
  return state;
}
