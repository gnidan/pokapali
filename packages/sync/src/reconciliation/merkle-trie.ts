/**
 * Binary prefix Merkle trie over SHA-256 edit hashes.
 *
 * Each bit of a 32-byte hash determines left (0) or right (1)
 * descent.  Internal nodes carry the XOR fingerprint of every
 * leaf in their subtree; leaves carry a single edit hash.
 *
 * @module
 */

// -------------------------------------------------------
// Types
// -------------------------------------------------------

/**
 * A leaf holds one edit hash (32 bytes / 256 bits).
 */
export interface LeafNode {
  readonly kind: "leaf";
  readonly hash: Uint8Array;
}

/**
 * An internal node stores the XOR fingerprint of its
 * subtree and optional left/right children.
 */
export interface InternalNode {
  readonly kind: "internal";
  readonly fingerprint: Uint8Array;
  readonly editCount: number;
  readonly left: TrieNode | undefined;
  readonly right: TrieNode | undefined;
}

/**
 * Discriminated union of the two node kinds.
 */
export type TrieNode = LeafNode | InternalNode;

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/**
 * Return bit `bitIndex` of `hash` (0 = MSB of byte 0).
 */
function getBit(hash: Uint8Array, bitIndex: number): 0 | 1 {
  const byteIndex = bitIndex >>> 3;
  const bitOffset = 7 - (bitIndex & 7);
  return ((hash[byteIndex]! >>> bitOffset) & 1) as 0 | 1;
}

/**
 * XOR two equal-length byte arrays, returning a new array.
 */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

/**
 * 32 zero bytes — identity element for XOR.
 */
const ZERO_32 = new Uint8Array(32);

// -------------------------------------------------------
// Construction
// -------------------------------------------------------

/**
 * Build a binary prefix trie from a set of SHA-256 hashes.
 *
 * Complexity: O(n * hash-bit-length) in the worst case,
 * but shared prefixes collapse internal nodes.
 *
 * @param hashes - array of 32-byte SHA-256 digests
 * @returns root TrieNode (InternalNode if ≥ 0 hashes,
 *          or a degenerate internal wrapping a single leaf)
 */
export function buildTrie(hashes: Uint8Array[]): TrieNode {
  if (hashes.length === 0) {
    return emptyInternal();
  }

  let root: TrieNode = makeLeaf(hashes[0]!);
  for (let i = 1; i < hashes.length; i++) {
    root = insert(root, hashes[i]!, 0);
  }
  return root;
}

function emptyInternal(): InternalNode {
  return {
    kind: "internal",
    fingerprint: ZERO_32,
    editCount: 0,
    left: undefined,
    right: undefined,
  };
}

function makeLeaf(hash: Uint8Array): LeafNode {
  return { kind: "leaf", hash };
}

function fingerprint(node: TrieNode): Uint8Array {
  return node.kind === "leaf" ? node.hash : node.fingerprint;
}

function editCount(node: TrieNode): number {
  return node.kind === "leaf" ? 1 : node.editCount;
}

/**
 * Insert a hash into a subtree rooted at `node`, splitting
 * at `depth` bits.
 */
function insert(node: TrieNode, hash: Uint8Array, depth: number): TrieNode {
  if (node.kind === "leaf") {
    // If the existing leaf has the exact same hash, just
    // return it (duplicate).
    if (bytesEqual(node.hash, hash)) {
      return node;
    }
    // Split: create an internal node that distinguishes
    // the existing leaf from the new hash at bit `depth`.
    return splitLeaf(node, hash, depth);
  }

  // Internal node — descend left or right.
  const bit = getBit(hash, depth);
  const child = bit === 0 ? node.left : node.right;

  const newChild =
    child === undefined ? makeLeaf(hash) : insert(child, hash, depth + 1);

  const newLeft = bit === 0 ? newChild : node.left;
  const newRight = bit === 1 ? newChild : node.right;

  return buildInternal(newLeft, newRight);
}

function splitLeaf(
  existing: LeafNode,
  newHash: Uint8Array,
  depth: number,
): TrieNode {
  const eBit = getBit(existing.hash, depth);
  const nBit = getBit(newHash, depth);

  if (eBit === nBit) {
    // Same bit — need to descend further.
    const child = splitLeaf(existing, newHash, depth + 1);
    const left = eBit === 0 ? child : undefined;
    const right = eBit === 1 ? child : undefined;
    return buildInternal(left, right);
  }

  // Different bits — place each in its slot.
  const newLeaf = makeLeaf(newHash);
  const left = eBit === 0 ? existing : newLeaf;
  const right = eBit === 1 ? existing : newLeaf;
  return buildInternal(left, right);
}

function buildInternal(
  left: TrieNode | undefined,
  right: TrieNode | undefined,
): InternalNode {
  const lf = left ? fingerprint(left) : ZERO_32;
  const rf = right ? fingerprint(right) : ZERO_32;
  return {
    kind: "internal",
    fingerprint: xorBytes(lf, rf),
    editCount: (left ? editCount(left) : 0) + (right ? editCount(right) : 0),
    left,
    right,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// -------------------------------------------------------
// Queries
// -------------------------------------------------------

/**
 * Look up the fingerprint and edit count of the subtree
 * rooted at the node reached by following the first
 * `depth` bits of `prefix`.
 *
 * @param trie   - root of the trie
 * @param prefix - bit-packed prefix (only first `depth`
 *                 bits are examined)
 * @param depth  - number of prefix bits (0–256)
 * @returns fingerprint and editCount at that subtree
 */
export function queryPrefix(
  trie: TrieNode,
  prefix: Uint8Array,
  depth: number,
): { fingerprint: Uint8Array; editCount: number } {
  const node = descend(trie, prefix, depth, 0);
  if (node === undefined) {
    return { fingerprint: ZERO_32, editCount: 0 };
  }
  return {
    fingerprint: fingerprint(node),
    editCount: editCount(node),
  };
}

/**
 * Collect every hash stored under the subtree reached by
 * following the first `depth` bits of `prefix`.
 *
 * @param trie   - root of the trie
 * @param prefix - bit-packed prefix
 * @param depth  - number of prefix bits (0–256)
 * @returns array of 32-byte hashes
 */
export function collectHashes(
  trie: TrieNode,
  prefix: Uint8Array,
  depth: number,
): Uint8Array[] {
  const node = descend(trie, prefix, depth, 0);
  if (node === undefined) return [];
  return gather(node);
}

/**
 * Walk down the trie for `targetDepth` bits of `prefix`,
 * starting from bit `currentDepth`.
 */
function descend(
  node: TrieNode | undefined,
  prefix: Uint8Array,
  targetDepth: number,
  currentDepth: number,
): TrieNode | undefined {
  if (node === undefined) return undefined;
  if (currentDepth >= targetDepth) return node;

  if (node.kind === "leaf") {
    // Check whether the leaf's hash matches the remaining
    // prefix bits.
    for (let d = currentDepth; d < targetDepth; d++) {
      if (getBit(node.hash, d) !== getBit(prefix, d)) {
        return undefined;
      }
    }
    return node;
  }

  const bit = getBit(prefix, currentDepth);
  const child = bit === 0 ? node.left : node.right;
  return descend(child, prefix, targetDepth, currentDepth + 1);
}

/**
 * Collect all leaf hashes beneath a node.
 */
function gather(node: TrieNode): Uint8Array[] {
  if (node.kind === "leaf") return [node.hash];
  const result: Uint8Array[] = [];
  if (node.left) result.push(...gather(node.left));
  if (node.right) result.push(...gather(node.right));
  return result;
}
