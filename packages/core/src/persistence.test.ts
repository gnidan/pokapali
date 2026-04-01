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

function mockDoc(guid: string) {
  return { guid } as any;
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

  it("creates a provider per doc", () => {
    const docs = [
      mockDoc("test:content"),
      mockDoc("test:comments"),
      mockDoc("test:_meta"),
    ];
    const result = createDocPersistence(docs);

    expect(MockProvider).toHaveBeenCalledTimes(3);
    expect(result.providers.size).toBe(3);

    const guids = MockProvider.mock.calls.map((c: any) => c[0]);
    expect(guids).toContain("test:content");
    expect(guids).toContain("test:comments");
    expect(guids).toContain("test:_meta");
  });

  it("creates one provider for single doc", () => {
    const result = createDocPersistence([mockDoc("test:_meta")]);

    expect(MockProvider).toHaveBeenCalledTimes(1);
    expect(result.providers.size).toBe(1);
  });

  it("creates zero providers for empty array", () => {
    const result = createDocPersistence([]);

    expect(MockProvider).toHaveBeenCalledTimes(0);
    expect(result.providers.size).toBe(0);
  });

  it("passes doc guid and doc to" + " IndexeddbPersistence", () => {
    const docs = [mockDoc("test:content"), mockDoc("test:_meta")];
    createDocPersistence(docs);

    for (const call of MockProvider.mock.calls as any[][]) {
      const [guid, doc] = call;
      expect(guid).toBe(doc.guid);
    }
  });

  // ── whenSynced ─────────────────────────────────

  it("whenSynced resolves when all sync", async () => {
    const result = createDocPersistence([mockDoc("test:content")]);

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

    const result = createDocPersistence([mockDoc("test:content")]);

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
    const result = createDocPersistence([
      mockDoc("test:content"),
      mockDoc("test:_meta"),
    ]);
    const providers = [...result.providers];

    result.destroy();

    for (const p of providers) {
      expect(p.destroy).toHaveBeenCalled();
    }
  });

  it("destroy clears the providers set", () => {
    const result = createDocPersistence([
      mockDoc("test:a"),
      mockDoc("test:b"),
      mockDoc("test:_meta"),
    ]);
    expect(result.providers.size).toBe(3);

    result.destroy();
    expect(result.providers.size).toBe(0);
  });

  it("destroy calls closeBlockstore when set", async () => {
    const result = createDocPersistence([mockDoc("test:content")]);
    const closeFn = vi.fn(() => Promise.resolve());
    result.closeBlockstore = closeFn;

    result.destroy();
    await Promise.resolve();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("destroy does not throw without" + " closeBlockstore", () => {
    const result = createDocPersistence([mockDoc("test:content")]);
    expect(result.closeBlockstore).toBeUndefined();
    expect(() => result.destroy()).not.toThrow();
  });

  it("destroy swallows closeBlockstore rejection", async () => {
    const result = createDocPersistence([mockDoc("test:content")]);
    result.closeBlockstore = vi.fn(() =>
      Promise.reject(new Error("close failed")),
    );

    expect(() => result.destroy()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(result.closeBlockstore).toHaveBeenCalled();
  });

  it("double destroy is safe", () => {
    const result = createDocPersistence([mockDoc("test:content")]);

    result.destroy();
    expect(() => result.destroy()).not.toThrow();
    expect(result.providers.size).toBe(0);
  });

  // ── handle shape ───────────────────────────────

  it("returns a DocPersistence-shaped handle", () => {
    const result = createDocPersistence([mockDoc("test:content")]);

    expect(result).toHaveProperty("whenSynced");
    expect(result).toHaveProperty("providers");
    expect(result).toHaveProperty("destroy");
    expect(result.whenSynced).toBeInstanceOf(Promise);
    expect(result.providers).toBeInstanceOf(Set);
    expect(typeof result.destroy).toBe("function");
  });
});
