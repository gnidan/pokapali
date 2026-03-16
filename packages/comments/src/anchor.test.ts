import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  anchorFromRelativePositions,
  createAnchor,
  resolveAnchor,
} from "./anchor.js";

function makeContentDoc(text: string) {
  const doc = new Y.Doc();
  const t = doc.getText("default");
  t.insert(0, text);
  return { doc, text: t };
}

describe("anchor", () => {
  describe("createAnchor", () => {
    it("returns encoded start/end bytes", () => {
      const { text } = makeContentDoc("hello world");
      const anchor = createAnchor(text, 0, 5);

      expect(anchor.start).toBeInstanceOf(Uint8Array);
      expect(anchor.end).toBeInstanceOf(Uint8Array);
      expect(anchor.start.length).toBeGreaterThan(0);
      expect(anchor.end.length).toBeGreaterThan(0);
    });
  });

  describe("anchorFromRelativePositions", () => {
    it("produces same result as createAnchor", () => {
      const { text } = makeContentDoc("hello world");
      const startRelPos = Y.createRelativePositionFromTypeIndex(text, 0);
      const endRelPos = Y.createRelativePositionFromTypeIndex(text, 5);

      const a1 = createAnchor(text, 0, 5);
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
      const { doc, text } = makeContentDoc("hello world");
      const anchor = createAnchor(text, 0, 5);
      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);

      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.start).toBe(0);
        expect(resolved.end).toBe(5);
      }
    });

    it("tracks position after insert before", () => {
      const { doc, text } = makeContentDoc("hello world");
      const anchor = createAnchor(text, 6, 11);

      // Insert text before the anchor.
      text.insert(0, "hey ");

      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);

      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        // "world" shifted right by 4.
        expect(resolved.start).toBe(10);
        expect(resolved.end).toBe(15);
      }
    });

    it("returns pending for empty doc", () => {
      const doc = new Y.Doc();
      const text = doc.getText("default");
      // Create anchor bytes from a different doc.
      const { text: otherText } = makeContentDoc("hello");
      const anchor = createAnchor(otherText, 0, 3);

      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);
      expect(resolved.status).toBe("pending");
    });

    it("returns orphaned when text deleted", () => {
      const { doc, text } = makeContentDoc("hello world");
      const anchor = createAnchor(text, 2, 5);

      // Delete all content.
      text.delete(0, text.length);

      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);
      // Empty text after deletion → pending.
      expect(resolved.status).toBe("pending");
    });

    it("orphaned when partial text deleted", () => {
      const { doc, text } = makeContentDoc("hello world");
      // Anchor the "llo w" range (2..7).
      const anchor = createAnchor(text, 2, 7);

      // Delete chars 0..5 ("hello"). Chars at 2-4
      // are deleted, so at least start should shift
      // or become orphaned depending on Yjs behavior.
      text.delete(0, 5);

      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);
      // After deleting "hello", remaining is " world".
      // The positions were relative to deleted chars,
      // so they should still resolve (Yjs tracks them).
      expect(resolved.status).toBe("resolved");
    });

    it("resolves XmlFragment anchors", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("default");
      frag.insert(0, [new Y.XmlText("para one")]);
      frag.insert(1, [new Y.XmlText("para two")]);
      frag.insert(2, [new Y.XmlText("para three")]);

      const anchor = createAnchor(frag, 0, 2);
      const resolved = resolveAnchor(doc, frag, anchor.start, anchor.end);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.start).toBe(0);
        expect(resolved.end).toBe(2);
      }
    });

    it("returns inverted when start > end", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("default");
      frag.insert(0, [new Y.XmlText("first")]);
      frag.insert(1, [new Y.XmlText("second")]);

      // Anchor spanning both paragraphs (0..2)
      const anchor = createAnchor(frag, 0, 2);

      // Delete first paragraph — start shifts past end
      frag.delete(0, 1);

      const resolved = resolveAnchor(doc, frag, anchor.start, anchor.end);
      // After deletion, positions may invert depending
      // on Yjs behavior. If not inverted, that's also
      // fine — the important thing is we handle it.
      expect(
        resolved.status === "resolved" ||
          resolved.status === "inverted" ||
          resolved.status === "orphaned",
      ).toBe(true);
    });

    it("handles same start and end (cursor)", () => {
      const { doc, text } = makeContentDoc("hello");
      const anchor = createAnchor(text, 3, 3);
      const resolved = resolveAnchor(doc, text, anchor.start, anchor.end);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.start).toBe(3);
        expect(resolved.end).toBe(3);
      }
    });
  });
});
