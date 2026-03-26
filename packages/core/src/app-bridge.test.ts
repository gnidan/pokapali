/**
 * Tests for App ↔ Document bridge wiring.
 *
 * Verifies that when a Doc has a bridged Document in
 * the docDocuments WeakMap (populated by createDoc),
 * App uses that Document for lifecycle management
 * instead of creating its own standalone Document.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track Document.create calls — App should NOT call
// this when a bridged Document exists in the WeakMap.
const standaloneCreateSpy = vi.fn();

vi.mock("@pokapali/document", () => ({
  Document: {
    create: standaloneCreateSpy.mockImplementation(() => {
      let level = "background";
      return {
        channel: vi.fn(),
        identity: {
          publicKey: new Uint8Array(32),
          privateKey: new Uint8Array(64),
        },
        capability: {
          channels: new Set(["content"]),
          canPushSnapshots: false,
          isAdmin: false,
        },
        get level() {
          return level;
        },
        activate: vi.fn((l: string) => {
          level = l;
        }),
        deactivate: vi.fn(() => {
          level = "background";
        }),
        destroy: vi.fn(),
      };
    }),
  },
}));

// Bridged Documents planted by the mock — one per
// doc, stored by ipnsName so tests can inspect them.
const bridgedDocs = new Map<string, any>();

/** Create a mock bridged Document with spies. */
function makeBridgedDocument() {
  let level = "background";
  return {
    channel: vi.fn(),
    identity: {
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    },
    capability: {
      channels: new Set(["content"]),
      canPushSnapshots: false,
      isAdmin: false,
    },
    get level() {
      return level;
    },
    activate: vi.fn((l: string) => {
      level = l;
    }),
    deactivate: vi.fn(() => {
      level = "background";
    }),
    destroy: vi.fn(),
  };
}

// Late reference — populated after import
let docDocumentsRef: WeakMap<any, any>;

const mockDestroy = vi.fn();
let docCounter = 0;

function makeMockDoc(ipnsName: string) {
  const doc = {
    ipnsName,
    destroy: mockDestroy,
    ready: vi.fn(async () => {}),
    urls: {
      admin: `https://example.com/doc/${ipnsName}#a`,
      write: `https://example.com/doc/${ipnsName}#w`,
      read: `https://example.com/doc/${ipnsName}#r`,
    },
  };
  // Simulate what createDoc does: plant a bridged
  // Document in the WeakMap for this Doc.
  const bridged = makeBridgedDocument();
  bridgedDocs.set(ipnsName, bridged);
  // Defer WeakMap set to next microtask so the
  // import resolves first — use queueMicrotask
  // in the create/open functions instead.
  return { doc, bridged };
}

vi.mock("./index.js", () => ({
  pokapali: vi.fn(() => ({
    create: vi.fn(async () => {
      const name = `doc-${++docCounter}`;
      const { doc, bridged } = makeMockDoc(name);
      docDocumentsRef?.set(doc, bridged);
      return doc;
    }),
    open: vi.fn(async (url: string) => {
      const match = url.match(/\/doc\/([^#]+)/);
      const name = match?.[1] ?? `opened-${++docCounter}`;
      const { doc, bridged } = makeMockDoc(name);
      docDocumentsRef?.set(doc, bridged);
      return doc;
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

const { docDocuments } = await import("./create-doc.js");
docDocumentsRef = docDocuments;

const { App } = await import("./app.js");

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
  };
}

describe("App ↔ Document bridge", () => {
  beforeEach(() => {
    docCounter = 0;
    mockDestroy.mockClear();
    standaloneCreateSpy.mockClear();
    bridgedDocs.clear();
  });

  it(
    "App skips Document.create() when bridged" + " Document exists in WeakMap",
    async () => {
      const app = await App.create({
        channels: ["content"],
        origin: "https://example.com",
        codec: fakeCodec(),
      });

      // App.create itself should not create
      // Documents yet
      expect(standaloneCreateSpy).not.toHaveBeenCalled();

      // Create a doc — the mock populates the
      // WeakMap, so App should find and use the
      // bridged Document
      await app.create();

      // App should NOT have called Document.create
      // since the bridged Document was in the WeakMap
      expect(standaloneCreateSpy).not.toHaveBeenCalled();
    },
  );

  it("lifecycle calls reach the bridged Document", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;
    const bridged = bridgedDocs.get(id)!;

    app.activate(id, "syncing");

    expect(bridged.activate).toHaveBeenCalledWith("syncing");
    expect(app.levelOf(id)).toBe("syncing");
  });

  it("deactivate reaches the bridged Document", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;
    const bridged = bridgedDocs.get(id)!;

    app.activate(id, "active");
    app.deactivate(id);

    expect(bridged.deactivate).toHaveBeenCalled();
    expect(app.levelOf(id)).toBe("background");
  });

  it("close() destroys the bridged Document", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    const id = [...app.documents.keys()][0]!;
    const bridged = bridgedDocs.get(id)!;

    app.close(id);

    expect(bridged.deactivate).toHaveBeenCalled();
    expect(bridged.destroy).toHaveBeenCalled();
  });

  it("destroy() cleans up all bridged Documents", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    await app.create();
    await app.create();
    const ids = [...app.documents.keys()];
    const b0 = bridgedDocs.get(ids[0]!)!;
    const b1 = bridgedDocs.get(ids[1]!)!;

    app.destroy();

    expect(b0.destroy).toHaveBeenCalled();
    expect(b1.destroy).toHaveBeenCalled();
  });

  it(
    "falls back to Document.create() when no" + " bridged Document in WeakMap",
    async () => {
      const app = await App.create({
        channels: ["content"],
        origin: "https://example.com",
        codec: fakeCodec(),
      });

      // Suppress WeakMap population so the mock
      // creates a Doc without a bridged Document.
      const origRef = docDocumentsRef;
      docDocumentsRef = null as any;

      standaloneCreateSpy.mockClear();

      // Create a doc — no WeakMap entry, so App
      // must fall back to Document.create().
      await app.create();

      // Restore for subsequent tests
      docDocumentsRef = origRef;

      // App should have called Document.create()
      // as fallback since no bridged Document
      // was in the WeakMap.
      expect(standaloneCreateSpy).toHaveBeenCalledTimes(1);

      // Lifecycle should still work via the
      // standalone Document
      const id = [...app.documents.keys()][0]!;
      app.activate(id, "active");
      expect(app.levelOf(id)).toBe("active");
    },
  );

  it("Doc interface works identically with" + " bridge wired in", async () => {
    const app = await App.create({
      channels: ["content"],
      origin: "https://example.com",
      codec: fakeCodec(),
    });

    const doc = await app.create();

    expect(doc.urls.admin).toContain("https://example.com/doc/");
    expect(doc.destroy).toBeTypeOf("function");
  });
});
