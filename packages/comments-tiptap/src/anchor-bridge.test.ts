import { describe, it, expect, vi } from "vitest";

/**
 * anchor-bridge tests.
 *
 * y-prosemirror and Tiptap require a full editor
 * environment to test position conversion. These
 * tests verify the module's logic paths using mocks
 * for the y-prosemirror internals.
 */

// Mock y-prosemirror before imports
vi.mock("y-prosemirror", () => ({
  absolutePositionToRelativePosition: vi.fn(),
  ySyncPluginKey: {
    getState: vi.fn(),
  },
}));

import { anchorFromSelection, getSyncState } from "./anchor-bridge.js";
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
} from "y-prosemirror";

function mockEditor(from: number, to: number) {
  return {
    state: {
      selection: { from, to },
    },
  } as any;
}

describe("getSyncState", () => {
  it("returns null when sync plugin is not active", () => {
    vi.mocked(ySyncPluginKey.getState).mockReturnValue(undefined);
    const editor = mockEditor(0, 5);
    expect(getSyncState(editor)).toBeNull();
  });

  it("returns null when binding has no mapping", () => {
    vi.mocked(ySyncPluginKey.getState).mockReturnValue({ binding: {} });
    const editor = mockEditor(0, 5);
    expect(getSyncState(editor)).toBeNull();
  });

  it("returns sync state when valid", () => {
    const state = {
      doc: {},
      type: {},
      binding: { mapping: {} },
    };
    vi.mocked(ySyncPluginKey.getState).mockReturnValue(state);
    const editor = mockEditor(0, 5);
    expect(getSyncState(editor)).toBe(state);
  });
});

describe("anchorFromSelection", () => {
  it("returns null for collapsed selection", () => {
    vi.mocked(ySyncPluginKey.getState).mockReturnValue({
      binding: { mapping: {} },
      type: {},
      doc: {},
    });
    const editor = mockEditor(5, 5);
    expect(anchorFromSelection(editor)).toBeNull();
  });

  it("returns null when sync state unavailable", () => {
    vi.mocked(ySyncPluginKey.getState).mockReturnValue(undefined);
    const editor = mockEditor(0, 10);
    expect(anchorFromSelection(editor)).toBeNull();
  });

  it("returns null when position conversion fails", () => {
    vi.mocked(ySyncPluginKey.getState).mockReturnValue({
      binding: { mapping: {} },
      type: {},
      doc: {},
    });
    vi.mocked(absolutePositionToRelativePosition).mockReturnValue(null);
    const editor = mockEditor(0, 10);
    expect(anchorFromSelection(editor)).toBeNull();
  });

  it("returns Anchor on success", () => {
    const mapping = {};
    const xmlType = {};
    vi.mocked(ySyncPluginKey.getState).mockReturnValue({
      binding: { mapping },
      type: xmlType,
      doc: {},
    });
    const startRel = {
      type: null,
      tname: null,
      item: { id: { client: 1, clock: 0 } },
    };
    const endRel = {
      type: null,
      tname: null,
      item: { id: { client: 1, clock: 5 } },
    };
    vi.mocked(absolutePositionToRelativePosition)
      .mockReturnValueOnce(startRel)
      .mockReturnValueOnce(endRel);

    const editor = mockEditor(1, 6);
    const anchor = anchorFromSelection(editor);

    expect(anchor).not.toBeNull();
    expect(anchor!.start).toBeInstanceOf(Uint8Array);
    expect(anchor!.end).toBeInstanceOf(Uint8Array);

    // Verify correct args passed to y-prosemirror
    expect(absolutePositionToRelativePosition).toHaveBeenCalledWith(
      1,
      xmlType,
      mapping,
    );
    expect(absolutePositionToRelativePosition).toHaveBeenCalledWith(
      6,
      xmlType,
      mapping,
    );
  });
});
