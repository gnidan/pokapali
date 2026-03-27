/**
 * Tests for App → Document lifecycle wiring.
 *
 * Verifies that App manages Document lifecycle
 * transitions: activate/deactivate views based on
 * document context (foreground vs background).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pokapali() and its Doc return values
const mockDestroy = vi.fn();
let docCounter = 0;

function makeMockDoc(ipnsName: string) {
  return {
    ipnsName,
    destroy: mockDestroy,
    ready: vi.fn(async () => {}),
    urls: {
      admin: `https://example.com/doc/${ipnsName}#admin`,
      write: `https://example.com/doc/${ipnsName}#write`,
      read: `https://example.com/doc/${ipnsName}#read`,
    },
  };
}

vi.mock("./index.js", () => ({
  pokapali: vi.fn(() => ({
    create: vi.fn(async () => {
      const name = `doc-${++docCounter}`;
      return makeMockDoc(name);
    }),
    open: vi.fn(async (url: string) => {
      const match = url.match(/\/doc\/([^#]+)/);
      const name = match?.[1] ?? `opened-${++docCounter}`;
      return makeMockDoc(name);
    }),
    isDocUrl: vi.fn((url: string) =>
      url.startsWith("https://example.com/doc/"),
    ),
    docIdFromUrl: vi.fn((url: string) => {
      const match = url.match(/\/doc\/([^#]+)/);
      return match?.[1] ?? "";
    }),
  })),
}));

const { App } = await import("./app.js");

// -- Helpers --

function fakeCodec() {
  return {
    merge: (a: Uint8Array, b: Uint8Array) => {
      const c = new Uint8Array([...a, ...b]);
      c.sort();
      return c;
    },
    diff: (state: Uint8Array, base: Uint8Array) => {
      const s = new Set(base);
      return new Uint8Array([...state].filter((b) => !s.has(b)));
    },
    apply: (base: Uint8Array, update: Uint8Array) => {
      const c = new Uint8Array([...base, ...update]);
      c.sort();
      return c;
    },
    empty: () => new Uint8Array([]),
    contains: (snap: Uint8Array, edit: Uint8Array) => {
      const id = edit[0]!;
      for (const b of snap) {
        if (b === id) return true;
      }
      return false;
    },
    createSurface() {
      throw new Error("not implemented");
    },
    clockSum() {
      return 0;
    },
  };
}

describe("App lifecycle wiring", () => {
  beforeEach(() => {
    docCounter = 0;
    mockDestroy.mockClear();
  });

  it("new docs start at background level", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;

    expect(app.levelOf(id)).toBe("background");
  });

  it("activate sets doc level", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;

    app.activate(id, "active");

    expect(app.levelOf(id)).toBe("active");
  });

  it("deactivate returns doc to " + "background", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;

    app.activate(id, "syncing");
    expect(app.levelOf(id)).toBe("syncing");

    app.deactivate(id);
    expect(app.levelOf(id)).toBe("background");
  });

  it("activate unknown doc is a no-op", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    // Should not throw
    app.activate("nonexistent", "active");
    expect(app.levelOf("nonexistent")).toBeUndefined();
  });

  it("deactivate unknown doc is a no-op", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    // Should not throw
    app.deactivate("nonexistent");
  });

  it(
    "full lifecycle: open → activate → " + "deactivate → re-activate",
    async () => {
      const app = await App.create({
        channels: ["content"],
        origin: "https://example.com",
        codec: fakeCodec(),
      });

      const url = "https://example.com/doc/abc#capability";
      await app.open(url);

      // Start at background
      expect(app.levelOf("abc")).toBe("background");

      // Activate to syncing
      app.activate("abc", "syncing");
      expect(app.levelOf("abc")).toBe("syncing");

      // Background the doc
      app.deactivate("abc");
      expect(app.levelOf("abc")).toBe("background");

      // Re-activate
      app.activate("abc", "active");
      expect(app.levelOf("abc")).toBe("active");
    },
  );

  it("close removes lifecycle state", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;

    app.activate(id, "active");
    app.close(id);

    expect(app.levelOf(id)).toBeUndefined();
  });

  it("destroy clears all lifecycle state", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    await app.create();
    const ids = [...app.documents.keys()];

    app.activate(ids[0]!, "active");
    app.activate(ids[1]!, "syncing");

    app.destroy();

    expect(app.levelOf(ids[0]!)).toBeUndefined();
    expect(app.levelOf(ids[1]!)).toBeUndefined();
  });

  it("stepping through all levels", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;

    app.activate(id, "active");
    expect(app.levelOf(id)).toBe("active");

    app.activate(id, "syncing");
    expect(app.levelOf(id)).toBe("syncing");

    app.activate(id, "inspecting");
    expect(app.levelOf(id)).toBe("inspecting");

    // Step back down
    app.activate(id, "active");
    expect(app.levelOf(id)).toBe("active");
  });
});
