/**
 * Tests for Y.RelativePosition anchoring in
 * @pokapali/comments.
 *
 * STATUS: stubs only — fill in assertions when the
 * comments package merges into this branch.
 *
 * Anchors use Y.RelativePosition under the hood.
 * The content doc exposes Y.Text("default") for
 * Tiptap/ProseMirror compatibility.
 *
 * These focus on edge cases that complement
 * integrations' 40 tests.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

// ── Helpers ─────────────────────────────────────────

/**
 * Create a content Y.Doc with text in a Y.Text.
 * Returns the doc and the Y.Text element.
 */
function createContentDoc(text: string) {
  const doc = new Y.Doc();
  const yText = doc.getText("default");
  yText.insert(0, text);
  return { doc, yText };
}

/**
 * Create two synced content docs for concurrent
 * edit tests.
 */
function createSyncedContentDocs(text: string) {
  const { doc: doc1, yText: text1 } = createContentDoc(text);
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  const text2 = doc2.getText("default");
  return {
    doc1,
    text1,
    doc2,
    text2,
    sync() {
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    },
  };
}

// ── Anchor edge cases ───────────────────────────────

describe("anchor edge cases", () => {
  it("content deleted between anchor " + "points → status orphaned", () => {
    // const { doc, yText } =
    //   createContentDoc("Hello world");
    // // Anchor covers "Hello"
    // const anchor = c.createAnchor(0, 5);
    // c.add({ content: "Note", anchor, data: {} });
    // // Delete all text
    // yText.delete(0, yText.length);
    // const comment = c.feed.getSnapshot()[0];
    // expect(comment.anchor).toEqual({
    //   status: "orphaned",
    // });
    expect(true).toBe(true); // stub
  });

  it("content inserted before anchor → " + "anchor shifts correctly", () => {
    // const { doc, yText } =
    //   createContentDoc("Hello world");
    // // Anchor "world" at [6, 11]
    // const anchor = c.createAnchor(6, 11);
    // c.add({ content: "Note", anchor, data: {} });
    // // Insert "Hey " before → shifts anchor
    // yText.insert(0, "Hey ");
    // const comment = c.feed.getSnapshot()[0];
    // expect(comment.anchor).toEqual({
    //   status: "resolved", start: 10, end: 15,
    // });
    expect(true).toBe(true); // stub
  });

  it("content inserted within anchor " + "range → range expands", () => {
    // const { doc, yText } =
    //   createContentDoc("Hello world");
    // // Anchor [0, 11] covers all text
    // const anchor = c.createAnchor(0, 11);
    // // Insert " beautiful" after "Hello"
    // yText.insert(5, " beautiful");
    // // End should expand
    expect(true).toBe(true); // stub
  });

  it("concurrent edit by another client → " + "anchor survives merge", () => {
    // const { doc1, text1, doc2, text2, sync } =
    //   createSyncedContentDocs("Hello world");
    // // Client 1 creates anchor on "Hello"
    // // Client 2 inserts text before "Hello"
    // text2.insert(0, "Hey ");
    // sync();
    // // Anchor should still resolve (shifted)
    expect(true).toBe(true); // stub
  });

  it("range collapse (start === end) → " + "single-point anchor", () => {
    // const { doc } = createContentDoc("Hello");
    // const anchor = c.createAnchor(3, 3);
    // // Should resolve to { start: 3, end: 3 }
    expect(true).toBe(true); // stub
  });

  it("anchor with contentDoc not yet " + "loaded → status pending", () => {
    // Create comments doc with stored anchor
    // positions, but contentDoc Y.Text is empty
    // (not synced yet) → anchor.status "pending"
    expect(true).toBe(true); // stub
  });

  it("partial anchor deletion: start " + "intact but end deleted", () => {
    // const { doc, yText } =
    //   createContentDoc("Hello world");
    // // Anchor [0, 11]
    // // Delete "world" (chars 6-10)
    // yText.delete(6, 5);
    // // Start still valid, end may be orphaned
    // // or collapsed — verify behavior
    expect(true).toBe(true); // stub
  });

  it(
    "multiple anchors on overlapping " + "ranges resolve independently",
    () => {
      // Two comments anchored to overlapping text
      // regions. Edit within overlap should update
      // both anchors independently.
      expect(true).toBe(true); // stub
    },
  );

  it("anchor on empty document " + "(zero-length text)", () => {
    // const { doc } = createContentDoc("");
    // const anchor = c.createAnchor(0, 0);
    // // Should resolve to { start: 0, end: 0 }
    // // or "orphaned" depending on impl
    expect(true).toBe(true); // stub
  });
});
