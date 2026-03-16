import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useParticipants } from "./use-participants.js";
import type { Doc, ParticipantInfo } from "@pokapali/core";

type ChangeHandler = () => void;

function mockDoc(initial: ReadonlyMap<number, ParticipantInfo>): {
  doc: Doc;
  fire: () => void;
} {
  const listeners: ChangeHandler[] = [];
  const current = initial;
  const doc = {
    get participants() {
      return current;
    },
    awareness: {
      on(_event: string, cb: ChangeHandler) {
        listeners.push(cb);
      },
      off(_event: string, cb: ChangeHandler) {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    },
  } as unknown as Doc;

  return {
    doc,
    fire() {
      for (const cb of listeners) cb();
    },
  };
}

describe("useParticipants", () => {
  it("returns initial participants", () => {
    const map = new Map<number, ParticipantInfo>([[1, { pubkey: "abc" }]]);
    const { doc } = mockDoc(map);
    const { result } = renderHook(() => useParticipants(doc));
    expect(result.current).toBe(map);
  });

  it("updates on awareness change", () => {
    const map1 = new Map<number, ParticipantInfo>([[1, { pubkey: "abc" }]]);
    const { doc, fire } = mockDoc(map1);
    const { result } = renderHook(() => useParticipants(doc));

    const map2 = new Map<number, ParticipantInfo>([
      [1, { pubkey: "abc" }],
      [2, { pubkey: "def", displayName: "Alice" }],
    ]);
    // Mutate the doc mock to return new map
    Object.defineProperty(doc, "participants", {
      get: () => map2,
    });

    act(() => fire());
    expect(result.current).toBe(map2);
    expect(result.current.size).toBe(2);
  });

  it("unsubscribes on unmount", () => {
    const map = new Map<number, ParticipantInfo>();
    const { doc } = mockDoc(map);
    const offSpy = vi.spyOn(doc.awareness, "off");

    const { unmount } = renderHook(() => useParticipants(doc));

    unmount();
    expect(offSpy).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
