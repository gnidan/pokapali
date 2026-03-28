/**
 * Tests for app.ts — App type wrapping pokapali()
 * with document registry and lifecycle management.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Codec } from "@pokapali/codec";

function fakeCodec(): Codec {
  return {
    merge: (a, b) => {
      const c = new Uint8Array([...a, ...b]);
      c.sort();
      return c;
    },
    diff: (state, base) => {
      const s = new Set(base);
      return new Uint8Array([...state].filter((b) => !s.has(b)));
    },
    apply: (base, update) => {
      const c = new Uint8Array([...base, ...update]);
      c.sort();
      return c;
    },
    empty: () => new Uint8Array([]),
    contains: (snap, edit) => {
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

// Mock pokapali() and its Doc return values
const mockDestroy = vi.fn();
const mockReady = vi.fn(async () => {});
let docCounter = 0;

function makeMockDoc(ipnsName: string) {
  return {
    ipnsName,
    destroy: mockDestroy,
    ready: mockReady,
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

describe("App", () => {
  beforeEach(() => {
    docCounter = 0;
    mockDestroy.mockClear();
    mockReady.mockClear();
  });

  it("creates an App via App.create()", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    expect(app).toBeDefined();
    expect(app.documents).toBeInstanceOf(Map);
    expect(app.documents.size).toBe(0);
  });

  it("create() returns a Doc and registers it", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    const doc = await app.create();

    expect(doc).toBeDefined();
    expect(app.documents.size).toBe(1);
  });

  it("open() returns a Doc and registers it", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    const url = "https://example.com/doc/abc123#somecapability";
    const doc = await app.open(url);

    expect(doc).toBeDefined();
    expect(app.documents.size).toBe(1);
    expect(app.documents.has("abc123")).toBe(true);
  });

  it("open() same doc twice returns same Doc", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    const url = "https://example.com/doc/abc123#somecapability";
    const doc1 = await app.open(url);
    const doc2 = await app.open(url);

    expect(doc1).toBe(doc2);
    expect(app.documents.size).toBe(1);
  });

  it("close() removes doc from registry", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    const doc = await app.create();
    const id = [...app.documents.keys()][0]!;

    app.close(id);

    expect(app.documents.size).toBe(0);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("close() is a no-op for unknown id", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    app.close("nonexistent");

    expect(app.documents.size).toBe(0);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it("destroy() closes all docs", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    await app.create();
    expect(app.documents.size).toBe(2);

    app.destroy();

    expect(app.documents.size).toBe(0);
    expect(mockDestroy).toHaveBeenCalledTimes(2);
  });

  it("delegates isDocUrl to underlying app", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    expect(app.isDocUrl("https://example.com/doc/abc#cap")).toBe(true);
    expect(app.isDocUrl("https://other.com/doc/abc#cap")).toBe(false);
  });

  it("delegates docIdFromUrl to underlying app", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    expect(app.docIdFromUrl("https://example.com/doc/abc#cap")).toBe("abc");
  });

  it("exposes config on the instance", async () => {
    const app = await App.create({
      appId: "my-app",
      channels: ["content", "meta"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    expect(app.appId).toBe("my-app");
    expect(app.channels).toEqual(["content", "meta"]);
    expect(app.origin).toBe("https://example.com");
  });

  it("defaults appId to empty string", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    expect(app.appId).toBe("");
  });
});
