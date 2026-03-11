import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @pokapali/core before importing recentDocs
vi.mock("@pokapali/core", () => ({
  docIdFromUrl: (url: string) => {
    // Extract last path segment as docId
    const parts = url.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "unknown";
  },
}));

import {
  loadRecent,
  saveRecent,
  removeRecent,
  updateRecentTitle,
  type RecentDoc,
} from "./recentDocs.js";

// Simple in-memory localStorage mock
function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  } as Storage;
}

describe("recentDocs", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMockStorage(),
      writable: true,
      configurable: true,
    });
  });

  describe("loadRecent", () => {
    it("returns empty array when nothing stored", () => {
      expect(loadRecent()).toEqual([]);
    });

    it("returns empty array for invalid JSON", () => {
      localStorage.setItem("pokapali:recent-docs", "not json");
      expect(loadRecent()).toEqual([]);
    });

    it("returns empty array for non-array JSON", () => {
      localStorage.setItem(
        "pokapali:recent-docs",
        JSON.stringify({ not: "array" }),
      );
      expect(loadRecent()).toEqual([]);
    });

    it("filters out invalid entries", () => {
      localStorage.setItem(
        "pokapali:recent-docs",
        JSON.stringify([
          {
            url: "http://x/abc",
            docId: "abc",
            role: "Admin",
            lastOpened: 1000,
          },
          { bad: "entry" },
          null,
          {
            url: "",
            docId: "x",
            role: "Reader",
            lastOpened: 2000,
          },
        ]),
      );
      const result = loadRecent();
      expect(result).toHaveLength(1);
      expect(result[0].docId).toBe("abc");
    });
  });

  describe("saveRecent", () => {
    it("saves a new entry", () => {
      saveRecent("http://x/doc1", "Admin");
      const entries = loadRecent();
      expect(entries).toHaveLength(1);
      expect(entries[0].docId).toBe("doc1");
      expect(entries[0].role).toBe("Admin");
      expect(entries[0].url).toBe("http://x/doc1");
    });

    it("moves existing doc to front", () => {
      saveRecent("http://x/doc1", "Admin");
      saveRecent("http://x/doc2", "Reader");
      saveRecent("http://x/doc1", "Writer");
      const entries = loadRecent();
      expect(entries).toHaveLength(2);
      expect(entries[0].docId).toBe("doc1");
      expect(entries[0].role).toBe("Writer");
      expect(entries[1].docId).toBe("doc2");
    });

    it("preserves existing title if not provided", () => {
      saveRecent("http://x/doc1", "Admin", "My Doc");
      saveRecent("http://x/doc1", "Admin");
      const entries = loadRecent();
      expect(entries[0].title).toBe("My Doc");
    });

    it("trims to 15 entries", () => {
      for (let i = 0; i < 20; i++) {
        saveRecent(`http://x/doc${i}`, "Reader");
      }
      expect(loadRecent()).toHaveLength(15);
    });
  });

  describe("updateRecentTitle", () => {
    it("updates title for existing entry", () => {
      saveRecent("http://x/doc1", "Admin");
      updateRecentTitle("doc1", "New Title");
      const entries = loadRecent();
      expect(entries[0].title).toBe("New Title");
    });

    it("does nothing for unknown docId", () => {
      saveRecent("http://x/doc1", "Admin");
      updateRecentTitle("nonexistent", "Title");
      const entries = loadRecent();
      expect(entries[0].title).toBeUndefined();
    });
  });

  describe("removeRecent", () => {
    it("removes entry by docId", () => {
      saveRecent("http://x/doc1", "Admin");
      saveRecent("http://x/doc2", "Reader");
      removeRecent("doc1");
      const entries = loadRecent();
      expect(entries).toHaveLength(1);
      expect(entries[0].docId).toBe("doc2");
    });

    it("does nothing for unknown docId", () => {
      saveRecent("http://x/doc1", "Admin");
      removeRecent("nonexistent");
      expect(loadRecent()).toHaveLength(1);
    });
  });
});
