import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDocDestroy } from "./use-doc-destroy.js";
import type { Doc } from "@pokapali/core";

function mockDoc(): Doc {
  return {
    destroy: vi.fn(),
  } as unknown as Doc;
}

describe("useDocDestroy", () => {
  it("does not destroy while mounted", () => {
    const doc = mockDoc();
    renderHook(() => useDocDestroy(doc));
    expect(doc.destroy).not.toHaveBeenCalled();
  });

  it("destroys on unmount", () => {
    const doc = mockDoc();
    const { unmount } = renderHook(() => useDocDestroy(doc));

    unmount();
    expect(doc.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys old doc on doc change", () => {
    const doc1 = mockDoc();
    const doc2 = mockDoc();
    const { rerender } = renderHook(({ doc }) => useDocDestroy(doc), {
      initialProps: { doc: doc1 },
    });

    rerender({ doc: doc2 });
    expect(doc1.destroy).toHaveBeenCalledTimes(1);
    expect(doc2.destroy).not.toHaveBeenCalled();
  });

  it("destroys new doc on final unmount", () => {
    const doc1 = mockDoc();
    const doc2 = mockDoc();
    const { rerender, unmount } = renderHook(({ doc }) => useDocDestroy(doc), {
      initialProps: { doc: doc1 },
    });

    rerender({ doc: doc2 });
    unmount();
    expect(doc1.destroy).toHaveBeenCalledTimes(1);
    expect(doc2.destroy).toHaveBeenCalledTimes(1);
  });
});
