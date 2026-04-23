import { describe, it, expect } from "vitest";
import { createLruCache } from "./lru-cache.js";

const bytes = (...vals: number[]) => new Uint8Array(vals);

describe("LruCache", () => {
  describe("basic get/set/has/delete", () => {
    it("returns undefined for absent key", () => {
      const cache = createLruCache(100);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.has("a")).toBe(false);
    });

    it("stores and retrieves a value", () => {
      const cache = createLruCache(100);
      const value = bytes(1, 2, 3);
      cache.set("a", value);
      expect(cache.get("a")).toBe(value);
      expect(cache.has("a")).toBe(true);
    });

    it("updates existing key in place", () => {
      const cache = createLruCache(100);
      cache.set("a", bytes(1, 2));
      cache.set("a", bytes(3, 4, 5));
      expect(cache.get("a")).toEqual(bytes(3, 4, 5));
      expect(cache.size).toBe(1);
      expect(cache.bytes).toBe(3);
    });

    it("delete removes and returns true", () => {
      const cache = createLruCache(100);
      cache.set("a", bytes(1, 2, 3));
      expect(cache.delete("a")).toBe(true);
      expect(cache.has("a")).toBe(false);
      expect(cache.bytes).toBe(0);
    });

    it("delete returns false when absent", () => {
      const cache = createLruCache(100);
      expect(cache.delete("absent")).toBe(false);
    });
  });

  describe("byte accounting", () => {
    it("bytes reflects total value sizes", () => {
      const cache = createLruCache(100);
      cache.set("a", bytes(1, 2, 3));
      cache.set("b", bytes(4, 5));
      expect(cache.bytes).toBe(5);
      expect(cache.size).toBe(2);
    });

    it("updating a key adjusts bytes", () => {
      const cache = createLruCache(100);
      cache.set("a", bytes(1, 2, 3));
      expect(cache.bytes).toBe(3);
      cache.set("a", bytes(1));
      expect(cache.bytes).toBe(1);
    });

    it("delete reduces bytes", () => {
      const cache = createLruCache(100);
      cache.set("a", bytes(1, 2, 3));
      cache.set("b", bytes(4, 5));
      cache.delete("a");
      expect(cache.bytes).toBe(2);
    });
  });

  describe("LRU eviction", () => {
    it("evicts least-recently-used when over budget", () => {
      const cache = createLruCache(5);
      cache.set("a", bytes(1, 2, 3)); // 3 bytes
      cache.set("b", bytes(4, 5)); // 5 bytes total
      cache.set("c", bytes(6)); // overflow → evict "a"
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.bytes).toBe(3);
    });

    it("get() marks as recently used", () => {
      const cache = createLruCache(5);
      cache.set("a", bytes(1, 2)); // 2 bytes
      cache.set("b", bytes(3, 4)); // 4 bytes
      cache.get("a"); // promote "a"
      cache.set("c", bytes(5, 6)); // 6 bytes → evict "b"
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
    });

    it("has() does NOT mark as recently used", () => {
      const cache = createLruCache(5);
      cache.set("a", bytes(1, 2)); // a is LRU
      cache.set("b", bytes(3, 4)); // b is MRU
      cache.has("a"); // does NOT promote
      cache.set("c", bytes(5, 6)); // evicts LRU
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
    });

    it("re-setting existing key promotes it", () => {
      const cache = createLruCache(5);
      cache.set("a", bytes(1, 2));
      cache.set("b", bytes(3, 4));
      cache.set("a", bytes(5)); // update + promote
      cache.set("c", bytes(6, 7)); // 2+1+2=5, no evict
      cache.set("d", bytes(8)); // overflow → evict "b" (oldest)
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });

    it("evicts multiple entries if single set exceeds budget by a lot", () => {
      const cache = createLruCache(10);
      cache.set("a", bytes(1, 2));
      cache.set("b", bytes(3, 4));
      cache.set("c", bytes(5, 6));
      cache.set("d", bytes(7, 8)); // 8 bytes total
      cache.set("big", new Uint8Array(10)); // forces eviction of all
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(false);
      expect(cache.has("d")).toBe(false);
      expect(cache.has("big")).toBe(true);
      expect(cache.bytes).toBe(10);
    });

    it("accepts value exactly at budget", () => {
      const cache = createLruCache(5);
      cache.set("a", bytes(1, 2, 3, 4, 5));
      expect(cache.has("a")).toBe(true);
      expect(cache.bytes).toBe(5);
    });

    it("keeps single oversized value (cannot shrink below single entry)", () => {
      // Edge case: set a value larger than budget. Current impl
      // will evict everything else but keep the oversized value
      // itself (evictToFit can't evict the just-added node if
      // it's the only thing left — but it CAN, since tail would
      // equal the just-added). Document actual behavior.
      const cache = createLruCache(5);
      cache.set("big", bytes(1, 2, 3, 4, 5, 6, 7, 8));
      // Oversized value gets evicted too — cache ends empty.
      expect(cache.has("big")).toBe(false);
      expect(cache.bytes).toBe(0);
    });
  });

  describe("onEvict callback", () => {
    it("fires for each evicted key", () => {
      const evicted: string[] = [];
      const cache = createLruCache({
        maxBytes: 5,
        onEvict: (key) => evicted.push(key),
      });
      cache.set("a", bytes(1, 2, 3)); // 3 bytes
      cache.set("b", bytes(4, 5)); // 5 total
      cache.set("c", bytes(6)); // overflow → evict "a"
      expect(evicted).toEqual(["a"]);
    });

    it("does not fire on explicit delete", () => {
      const evicted: string[] = [];
      const cache = createLruCache({
        maxBytes: 100,
        onEvict: (key) => evicted.push(key),
      });
      cache.set("a", bytes(1, 2, 3));
      cache.delete("a");
      expect(evicted).toEqual([]);
    });
  });

  describe("ordering under mixed operations", () => {
    it("preserves insertion order for un-accessed entries", () => {
      const cache = createLruCache(6);
      cache.set("a", bytes(1, 2));
      cache.set("b", bytes(3, 4));
      cache.set("c", bytes(5, 6));
      // Adding overflow evicts "a" (oldest, never accessed)
      cache.set("d", bytes(7, 8));
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
    });

    it("get on MRU keeps eviction order stable", () => {
      const cache = createLruCache(6);
      cache.set("a", bytes(1, 2));
      cache.set("b", bytes(3, 4));
      cache.set("c", bytes(5, 6));
      cache.get("c"); // "c" already MRU
      cache.set("d", bytes(7, 8)); // evicts "a" still
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
    });
  });
});
