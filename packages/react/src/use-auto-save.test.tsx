import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutoSave } from "./use-auto-save.js";
import type { Doc } from "@pokapali/core";
import * as core from "@pokapali/core";

vi.mock("@pokapali/core", async () => {
  const actual = await vi.importActual("@pokapali/core");
  return {
    ...actual,
    createAutoSaver: vi.fn(() => vi.fn()),
  };
});

const mockCreateAutoSaver = vi.mocked(core.createAutoSaver);

function mockDoc(): Doc {
  return {} as unknown as Doc;
}

describe("useAutoSave", () => {
  beforeEach(() => {
    mockCreateAutoSaver.mockClear();
    mockCreateAutoSaver.mockReturnValue(vi.fn());
  });

  it("calls createAutoSaver on mount", () => {
    const doc = mockDoc();
    renderHook(() => useAutoSave(doc));

    expect(mockCreateAutoSaver).toHaveBeenCalledWith(doc, undefined);
  });

  it("passes debounceMs as options", () => {
    const doc = mockDoc();
    renderHook(() => useAutoSave(doc, 3000));

    expect(mockCreateAutoSaver).toHaveBeenCalledWith(doc, { debounceMs: 3000 });
  });

  it("calls cleanup on unmount", () => {
    const cleanup = vi.fn();
    mockCreateAutoSaver.mockReturnValue(cleanup);

    const doc = mockDoc();
    const { unmount } = renderHook(() => useAutoSave(doc));

    expect(cleanup).not.toHaveBeenCalled();
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("re-creates on doc change", () => {
    const cleanup1 = vi.fn();
    const cleanup2 = vi.fn();
    mockCreateAutoSaver
      .mockReturnValueOnce(cleanup1)
      .mockReturnValueOnce(cleanup2);

    const doc1 = mockDoc();
    const doc2 = mockDoc();
    const { rerender } = renderHook(({ doc }) => useAutoSave(doc), {
      initialProps: { doc: doc1 },
    });

    expect(mockCreateAutoSaver).toHaveBeenCalledTimes(1);

    rerender({ doc: doc2 });
    expect(cleanup1).toHaveBeenCalledTimes(1);
    expect(mockCreateAutoSaver).toHaveBeenCalledTimes(2);
  });
});
