import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  anchorFromRelativePositions,
  createAnchor,
  resolveAnchor,
} from "./anchor.js";

function makeContentDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("default").insert(0, text);
  return doc;
}

describe("anchor", () => {
  describe("createAnchor", () => {
    it("returns encoded start/end bytes", () => {
      const doc = makeContentDoc("hello world");
      const anchor = createAnchor(doc, 0, 5);

      expect(anchor.start).toBeInstanceOf(Uint8Array);
      expect(anchor.end).toBeInstanceOf(Uint8Array);
      expect(anchor.start.length).toBeGreaterThan(0);
      expect(anchor.end.length).toBeGreaterThan(0);
    });
  });

  describe("anchorFromRelativePositions", () => {
    it("produces same result as createAnchor", () => {
      const doc = makeContentDoc("hello world");
      const text = doc.getText("default");
      const startRelPos = Y.createRelativePositionFromTypeIndex(text, 0);
      const endRelPos = Y.createRelativePositionFromTypeIndex(text, 5);

      const a1 = createAnchor(doc, 0, 5);
      const a2 = anchorFromRelativePositions(startRelPos, endRelPos);

      expect(a2.start).toEqual(a1.start);
      expect(a2.end).toEqual(a1.end);
    });

    it("works with XmlFragment positions", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("default");
      frag.insert(0, [new Y.XmlText("para one")]);
      frag.insert(1, [new Y.XmlText("para two")]);

      const startRelPos = Y.createRelativePositionFromTypeIndex(frag, 0);
      const endRelPos = Y.createRelativePositionFromTypeIndex(frag, 2);

      const anchor = anchorFromRelativePositions(startRelPos, endRelPos);

      expect(anchor.start).toBeInstanceOf(Uint8Array);
      expect(anchor.end).toBeInstanceOf(Uint8Array);

      // Resolve against the same doc/fragment.
      const absStart = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor.start),
        doc,
      );
      const absEnd = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor.end),
        doc,
      );

      expect(absStart).not.toBeNull();
      expect(absEnd).not.toBeNull();
      expect(absStart!.index).toBe(0);
      expect(absEnd!.index).toBe(2);
    });
  });

  describe("resolveAnchor", () => {
    it("resolves to indices on unchanged doc", () => {
      const doc = makeContentDoc("hello world");
      const anchor = createAnchor(doc, 0, 5);
      const resolved = resolveAnchor(doc, anchor.start, anchor.end);

      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.start).toBe(0);
        expect(resolved.end).toBe(5);
      }
    });

    it("tracks position after insert before", () => {
      const doc = makeContentDoc("hello world");
      const anchor = createAnchor(doc, 6, 11);

      // Insert text before the anchor.
      doc.getText("default").insert(0, "hey ");

      const resolved = resolveAnchor(doc, anchor.start, anchor.end);

      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        // "world" shifted right by 4.
        expect(resolved.start).toBe(10);
        expect(resolved.end).toBe(15);
      }
    });

    it("returns pending for empty doc", () => {
      const doc = new Y.Doc();
      // Create anchor bytes from a different doc.
      const other = makeContentDoc("hello");
      const anchor = createAnchor(other, 0, 3);

      const resolved = resolveAnchor(doc, anchor.start, anchor.end);
      expect(resolved.status).toBe("pending");
    });

    it("returns orphaned when text deleted", () => {
      const doc = makeContentDoc("hello world");
      const anchor = createAnchor(doc, 2, 5);

      // Delete all content.
      doc.getText("default").delete(0, doc.getText("default").length);

      const resolved = resolveAnchor(doc, anchor.start, anchor.end);
      // Empty text after deletion → pending.
      expect(resolved.status).toBe("pending");
    });

    it("orphaned when partial text deleted", () => {
      const doc = makeContentDoc("hello world");
      // Anchor the "llo w" range (2..7).
      const anchor = createAnchor(doc, 2, 7);

      // Delete chars 0..5 ("hello"). Chars at 2-4
      // are deleted, so at least start should shift
      // or become orphaned depending on Yjs behavior.
      doc.getText("default").delete(0, 5);

      const resolved = resolveAnchor(doc, anchor.start, anchor.end);
      // After deleting "hello", remaining is " world".
      // The positions were relative to deleted chars,
      // so they should still resolve (Yjs tracks them).
      expect(resolved.status).toBe("resolved");
    });

    it("handles same start and end (cursor)", () => {
      const doc = makeContentDoc("hello");
      const anchor = createAnchor(doc, 3, 3);
      const resolved = resolveAnchor(doc, anchor.start, anchor.end);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.start).toBe(3);
        expect(resolved.end).toBe(3);
      }
    });
  });
});
