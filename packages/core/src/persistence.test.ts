import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWhenSynced = Promise.resolve({} as any);
const MockProvider = vi.fn(() => ({
  whenSynced: mockWhenSynced,
  destroy: vi.fn(),
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: MockProvider,
}));

const { createDocPersistence } = await import("./persistence.js");

function mockSubdocManager() {
  return {
    subdoc: vi.fn((ns: string) => ({
      guid: `test-ipns:${ns}`,
    })),
  } as any;
}

describe("createDocPersistence", () => {
  beforeEach(() => {
    MockProvider.mockClear();
    MockProvider.mockImplementation(() => ({
      whenSynced: mockWhenSynced,
      destroy: vi.fn(),
    }));
  });

  // ── provider creation ──────────────────────────

  it("creates a provider per namespace + _meta", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content", "comments"]);

    // content + comments + _meta = 3 providers
    expect(MockProvider).toHaveBeenCalledTimes(3);
    expect(result.providers.size).toBe(3);

    const guids = MockProvider.mock.calls.map((c: any) => c[0]);
    expect(guids).toContain("test-ipns:content");
    expect(guids).toContain("test-ipns:comments");
    expect(guids).toContain("test-ipns:_meta");
  });

  it("creates only _meta provider for empty namespaces", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, []);

    expect(MockProvider).toHaveBeenCalledTimes(1);
    expect(result.providers.size).toBe(1);

    const guid = MockProvider.mock.calls[0][0];
    expect(guid).toBe("test-ipns:_meta");
  });

  it("creates 2 providers for single namespace", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);

    // content + _meta = 2
    expect(MockProvider).toHaveBeenCalledTimes(2);
    expect(result.providers.size).toBe(2);
  });

  it("calls subdoc with each namespace and _meta", () => {
    const mgr = mockSubdocManager();
    createDocPersistence(mgr, ["a", "b", "c"]);

    const nsArgs = mgr.subdoc.mock.calls.map((c: any) => c[0]);
    expect(nsArgs).toEqual(["a", "b", "c", "_meta"]);
  });

  it("passes subdoc guid and doc to IndexeddbPersistence", () => {
    const mgr = mockSubdocManager();
    createDocPersistence(mgr, ["content"]);

    // Check second arg (the doc object) was passed
    for (const call of MockProvider.mock.calls) {
      const [guid, doc] = call as [string, any];
      expect(guid).toBe(doc.guid);
    }
  });

  // ── whenSynced ─────────────────────────────────

  it("whenSynced resolves when all providers sync", async () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);

    await expect(result.whenSynced).resolves.toBeUndefined();
  });

  it("whenSynced waits for slow providers", async () => {
    let resolve!: () => void;
    const slow = new Promise<void>((r) => {
      resolve = r;
    });

    MockProvider.mockImplementation(() => ({
      whenSynced: slow,
      destroy: vi.fn(),
    }));

    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);

    let synced = false;
    result.whenSynced.then(() => {
      synced = true;
    });

    // Not yet resolved
    await Promise.resolve();
    expect(synced).toBe(false);

    resolve();
    await result.whenSynced;
    expect(synced).toBe(true);
  });

  // ── destroy ────────────────────────────────────

  it("destroy calls destroy on all providers", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);
    const providers = [...result.providers];

    result.destroy();

    for (const p of providers) {
      expect(p.destroy).toHaveBeenCalled();
    }
  });

  it("destroy clears the providers set", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["a", "b"]);
    expect(result.providers.size).toBe(3);

    result.destroy();
    expect(result.providers.size).toBe(0);
  });

  it("destroy calls closeBlockstore when set", async () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);
    const closeFn = vi.fn(() => Promise.resolve());
    result.closeBlockstore = closeFn;

    result.destroy();
    await Promise.resolve();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("destroy does not throw without closeBlockstore", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);
    // closeBlockstore is undefined by default
    expect(result.closeBlockstore).toBeUndefined();
    expect(() => result.destroy()).not.toThrow();
  });

  it("destroy swallows closeBlockstore rejection", async () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);
    result.closeBlockstore = vi.fn(() =>
      Promise.reject(new Error("close failed")),
    );

    // Should not throw
    expect(() => result.destroy()).not.toThrow();
    // Give the catch handler time to run
    await new Promise((r) => setTimeout(r, 10));
    expect(result.closeBlockstore).toHaveBeenCalled();
  });

  it("double destroy is safe", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);

    result.destroy();
    expect(() => result.destroy()).not.toThrow();
    expect(result.providers.size).toBe(0);
  });

  // ── handle shape ───────────────────────────────

  it("returns a DocPersistence-shaped handle", () => {
    const mgr = mockSubdocManager();
    const result = createDocPersistence(mgr, ["content"]);

    expect(result).toHaveProperty("whenSynced");
    expect(result).toHaveProperty("providers");
    expect(result).toHaveProperty("destroy");
    expect(result.whenSynced).toBeInstanceOf(Promise);
    expect(result.providers).toBeInstanceOf(Set);
    expect(typeof result.destroy).toBe("function");
  });
});
