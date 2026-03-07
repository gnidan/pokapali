import type { CID } from "multiformats/cid";
import type { Ed25519KeyPair } from "@pokapali/crypto";

export interface SnapshotNode {
  subdocs: Record<string, Uint8Array>;
  prev: CID | null;
  seq: number;
  ts: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export function encodeSnapshot(
  plaintextSubdocs: Record<string, Uint8Array>,
  readKey: CryptoKey,
  prev: CID | null,
  seq: number,
  ts: number,
  signingKey: Ed25519KeyPair
): Promise<Uint8Array> {
  throw new Error("not implemented");
}

export function decodeSnapshot(
  bytes: Uint8Array
): SnapshotNode {
  throw new Error("not implemented");
}

export function decryptSnapshot(
  node: SnapshotNode,
  readKey: CryptoKey
): Promise<Record<string, Uint8Array>> {
  throw new Error("not implemented");
}

export function validateStructure(
  block: Uint8Array
): Promise<boolean> {
  throw new Error("not implemented");
}

export async function* walkChain(
  tipCid: CID,
  blockGetter: (cid: CID) => Promise<Uint8Array>
): AsyncGenerator<SnapshotNode> {
  throw new Error("not implemented");
}

// Pure state machine for fetch coalescing
export interface FetchCoalescerState {
  pending: Set<string>;
  inflight: Set<string>;
  resolved: Map<string, Uint8Array>;
  failed: Set<string>;
}

export function createFetchCoalescerState():
  FetchCoalescerState {
  throw new Error("not implemented");
}

export function coalescerNext(
  state: FetchCoalescerState
): { toFetch: string[] } {
  throw new Error("not implemented");
}

export function coalescerResolve(
  state: FetchCoalescerState,
  cid: string,
  block: Uint8Array
): FetchCoalescerState {
  throw new Error("not implemented");
}

export function coalescerFail(
  state: FetchCoalescerState,
  cid: string
): FetchCoalescerState {
  throw new Error("not implemented");
}
