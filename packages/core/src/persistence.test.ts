import { describe, it, expect, vi } from "vitest";

const mockWhenSynced = Promise.resolve({} as any);
const MockProvider = vi.fn(() => ({
  whenSynced: mockWhenSynced,
  destroy: vi.fn(),
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: MockProvider,
}));

const { createDocPersistence } = await import("./persistence.js");

describe("createDocPersistence", () => {
  it("creates a provider per namespace + _meta", () => {
    const mockSubdocManager = {
      subdoc: vi.fn((ns: string) => ({
        guid: `test-ipns:${ns}`,
      })),
    } as any;

    const result = createDocPersistence(mockSubdocManager, [
      "content",
      "comments",
    ]);

    // content + comments + _meta = 3 providers
    expect(MockProvider).toHaveBeenCalledTimes(3);
    expect(result.providers.size).toBe(3);

    // Check guids passed to IndexeddbPersistence
    const calls = MockProvider.mock.calls;
    const guids = calls.map((c: any) => c[0]);
    expect(guids).toContain("test-ipns:content");
    expect(guids).toContain("test-ipns:comments");
    expect(guids).toContain("test-ipns:_meta");
  });

  it("whenSynced resolves when all providers sync", async () => {
    const mockSubdocManager = {
      subdoc: vi.fn(() => ({ guid: "g" })),
    } as any;

    const result = createDocPersistence(mockSubdocManager, ["content"]);

    await expect(result.whenSynced).resolves.toBeUndefined();
  });

  it("destroy() calls destroy on all providers", () => {
    const mockSubdocManager = {
      subdoc: vi.fn(() => ({ guid: "g" })),
    } as any;

    MockProvider.mockClear();
    const result = createDocPersistence(mockSubdocManager, ["content"]);

    const providers = [...result.providers];
    result.destroy();

    for (const p of providers) {
      expect(p.destroy).toHaveBeenCalled();
    }
    expect(result.providers.size).toBe(0);
  });

  it("destroy() calls closeBlockstore when set", async () => {
    const mockSubdocManager = {
      subdoc: vi.fn(() => ({ guid: "g" })),
    } as any;

    MockProvider.mockClear();
    const result = createDocPersistence(mockSubdocManager, ["content"]);

    const closeFn = vi.fn(() => Promise.resolve());
    result.closeBlockstore = closeFn;

    result.destroy();
    // closeBlockstore is fire-and-forget
    await Promise.resolve();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});
