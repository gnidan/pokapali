/**
 * lru-cache.ts — byte-budget bounded LRU cache.
 *
 * Used by BlockResolver (A2) to bound in-memory
 * block storage to a configurable byte budget.
 * Keyed by string (cid.toString() at call sites).
 *
 * Least-recently-used entries are evicted until the
 * total bytes tracked falls under the budget. Access
 * via get() or set() marks an entry as recently used.
 *
 * NOT thread-safe (single-threaded JS runtime only).
 * NOT persistent — pure in-memory.
 */

interface Node {
  key: string;
  value: Uint8Array;
  size: number;
  prev: Node | null;
  next: Node | null;
}

export interface LruCache {
  /** Returns the value and marks it as recently used,
   *  or undefined if absent. */
  get(key: string): Uint8Array | undefined;

  /** Stores value under key, evicting LRU entries if
   *  total bytes would exceed maxBytes. Updates
   *  existing entries in place (marked recently used). */
  set(key: string, value: Uint8Array): void;

  /** Returns true if the key is present (does not
   *  mark as recently used). */
  has(key: string): boolean;

  /** Removes key; returns true if present. */
  delete(key: string): boolean;

  /** Current number of entries. */
  readonly size: number;

  /** Current total bytes across all entries. */
  readonly bytes: number;
}

export interface LruCacheOptions {
  maxBytes: number;
  /** Called when a key is evicted due to byte-budget
   *  pressure. NOT called on explicit delete(). */
  onEvict?: (key: string) => void;
}

export function createLruCache(
  optsOrMaxBytes: number | LruCacheOptions,
): LruCache {
  const opts =
    typeof optsOrMaxBytes === "number"
      ? { maxBytes: optsOrMaxBytes }
      : optsOrMaxBytes;
  const { maxBytes, onEvict } = opts;

  const nodes = new Map<string, Node>();
  let head: Node | null = null; // most recent
  let tail: Node | null = null; // least recent
  let totalBytes = 0;

  function unlink(node: Node): void {
    if (node.prev) node.prev.next = node.next;
    else head = node.next;
    if (node.next) node.next.prev = node.prev;
    else tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  function linkAtHead(node: Node): void {
    node.prev = null;
    node.next = head;
    if (head) head.prev = node;
    head = node;
    if (!tail) tail = node;
  }

  function evictToFit(): void {
    while (totalBytes > maxBytes && tail) {
      const evicting = tail;
      unlink(evicting);
      nodes.delete(evicting.key);
      totalBytes -= evicting.size;
      onEvict?.(evicting.key);
    }
  }

  return {
    get(key) {
      const node = nodes.get(key);
      if (!node) return undefined;
      // Move to head (mark recently used)
      unlink(node);
      linkAtHead(node);
      return node.value;
    },

    set(key, value) {
      const existing = nodes.get(key);
      if (existing) {
        totalBytes -= existing.size;
        existing.value = value;
        existing.size = value.byteLength;
        totalBytes += existing.size;
        unlink(existing);
        linkAtHead(existing);
      } else {
        const node: Node = {
          key,
          value,
          size: value.byteLength,
          prev: null,
          next: null,
        };
        nodes.set(key, node);
        linkAtHead(node);
        totalBytes += node.size;
      }
      evictToFit();
    },

    has(key) {
      return nodes.has(key);
    },

    delete(key) {
      const node = nodes.get(key);
      if (!node) return false;
      unlink(node);
      nodes.delete(key);
      totalBytes -= node.size;
      return true;
    },

    get size() {
      return nodes.size;
    },

    get bytes() {
      return totalBytes;
    },
  };
}
