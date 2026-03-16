import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

vi.mock("y-prosemirror", () => ({
  relativePositionToAbsolutePosition: vi.fn(),
}));

import { resolveAnchors } from "./resolve.js";
import { relativePositionToAbsolutePosition } from "y-prosemirror";

describe("resolveAnchors", () => {
  let commentsDoc: Y.Doc;
  let contentDoc: Y.Doc;

  beforeEach(() => {
    commentsDoc = new Y.Doc();
    contentDoc = new Y.Doc();
    vi.clearAllMocks();
  });

  it("returns empty array when syncState is null", () => {
    expect(resolveAnchors(commentsDoc, contentDoc, null)).toEqual([]);
  });

  it("returns empty array when no comments", () => {
    const syncState = {
      doc: contentDoc,
      type: {},
      binding: { mapping: {} },
    } as any;
    expect(resolveAnchors(commentsDoc, contentDoc, syncState)).toEqual([]);
  });

  it("resolves anchors to PM positions", () => {
    const commentsMap = commentsDoc.getMap("comments");
    const entry = new Y.Map();

    const contentType = contentDoc.getText("default");
    contentType.insert(0, "Hello world");
    const startRel = Y.createRelativePositionFromTypeIndex(contentType, 0);
    const endRel = Y.createRelativePositionFromTypeIndex(contentType, 5);
    entry.set("anchorStart", Y.encodeRelativePosition(startRel));
    entry.set("anchorEnd", Y.encodeRelativePosition(endRel));
    commentsMap.set("comment-1", entry);

    vi.mocked(relativePositionToAbsolutePosition)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(6);

    const syncState = {
      doc: contentDoc,
      type: {},
      binding: { mapping: {} },
    } as any;

    const result = resolveAnchors(commentsDoc, contentDoc, syncState);
    expect(result).toEqual([{ id: "comment-1", from: 1, to: 6 }]);
  });

  it("skips entries without Uint8Array anchors", () => {
    const commentsMap = commentsDoc.getMap("comments");
    const entry = new Y.Map();
    entry.set("anchorStart", "not-bytes");
    entry.set("anchorEnd", "not-bytes");
    commentsMap.set("bad-1", entry);

    const syncState = {
      doc: contentDoc,
      type: {},
      binding: { mapping: {} },
    } as any;

    expect(resolveAnchors(commentsDoc, contentDoc, syncState)).toEqual([]);
  });

  it("skips orphaned anchors (null resolution)", () => {
    const commentsMap = commentsDoc.getMap("comments");
    const entry = new Y.Map();
    const contentType = contentDoc.getText("default");
    contentType.insert(0, "text");
    const rel = Y.createRelativePositionFromTypeIndex(contentType, 0);
    entry.set("anchorStart", Y.encodeRelativePosition(rel));
    entry.set("anchorEnd", Y.encodeRelativePosition(rel));
    commentsMap.set("orphan-1", entry);

    vi.mocked(relativePositionToAbsolutePosition).mockReturnValue(null);

    const syncState = {
      doc: contentDoc,
      type: {},
      binding: { mapping: {} },
    } as any;

    expect(resolveAnchors(commentsDoc, contentDoc, syncState)).toEqual([]);
  });

  it("skips degenerate ranges (from >= to)", () => {
    const commentsMap = commentsDoc.getMap("comments");
    const entry = new Y.Map();
    const contentType = contentDoc.getText("default");
    contentType.insert(0, "text");
    const rel = Y.createRelativePositionFromTypeIndex(contentType, 0);
    entry.set("anchorStart", Y.encodeRelativePosition(rel));
    entry.set("anchorEnd", Y.encodeRelativePosition(rel));
    commentsMap.set("degen-1", entry);

    vi.mocked(relativePositionToAbsolutePosition).mockReturnValue(5);

    const syncState = {
      doc: contentDoc,
      type: {},
      binding: { mapping: {} },
    } as any;

    expect(resolveAnchors(commentsDoc, contentDoc, syncState)).toEqual([]);
  });
});
