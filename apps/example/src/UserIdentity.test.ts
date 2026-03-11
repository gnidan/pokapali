import { describe, it, expect, beforeEach } from "vitest";
import { loadUser, saveUser } from "./UserIdentity.js";

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

describe("UserIdentity", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMockStorage(),
      writable: true,
      configurable: true,
    });
  });

  describe("loadUser", () => {
    it("returns random color and empty name" + " when nothing stored", () => {
      const user = loadUser();
      expect(user.name).toBe("");
      expect(user.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("returns stored user when available", () => {
      localStorage.setItem(
        "pokapali:user",
        JSON.stringify({
          name: "Alice",
          color: "#ff0000",
        }),
      );
      const user = loadUser();
      expect(user.name).toBe("Alice");
      expect(user.color).toBe("#ff0000");
    });

    it("returns default when stored data is invalid", () => {
      localStorage.setItem("pokapali:user", "not json");
      const user = loadUser();
      expect(user.name).toBe("");
      expect(user.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("returns default when stored data" + " missing fields", () => {
      localStorage.setItem("pokapali:user", JSON.stringify({ name: "Bob" }));
      const user = loadUser();
      expect(user.name).toBe("");
    });
  });

  describe("saveUser", () => {
    it("persists user to localStorage", () => {
      saveUser({ name: "Alice", color: "#ff0000" });
      const raw = localStorage.getItem("pokapali:user");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.name).toBe("Alice");
      expect(parsed.color).toBe("#ff0000");
    });

    it("roundtrips through loadUser", () => {
      const user = { name: "Bob", color: "#00ff00" };
      saveUser(user);
      expect(loadUser()).toEqual(user);
    });
  });
});
