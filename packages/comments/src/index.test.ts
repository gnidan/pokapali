import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { setLogLevel, getLogLevel } from "@pokapali/log";
import { comments } from "./index.js";
import type { ClientIdMapping } from "./index.js";
import { createFeed } from "./feed.js";
import type { WritableFeed } from "./feed.js";

interface TestData {
  status: "open" | "resolved";
  resolvedBy: string | null;
}

const DEFAULT_DATA: TestData = {
  status: "open",
  resolvedBy: null,
};

function setup(clientID?: number) {
  const commentsDoc = new Y.Doc();
  const contentDoc = new Y.Doc();
  if (clientID !== undefined) {
    commentsDoc.clientID = clientID;
  }
  // Seed content so anchors can resolve.
  contentDoc.getText("default").insert(0, "hello world");

  const mappingFeed = createFeed<ClientIdMapping>(new Map());
  const c = comments<TestData>(commentsDoc, contentDoc, {
    author: "alice-pubkey",
    clientIdMapping: mappingFeed,
  });
  return {
    c,
    commentsDoc,
    contentDoc,
    mappingFeed,
  };
}

describe("comments()", () => {
  describe("add + feed round-trip", () => {
    it("adds a comment and projects it", () => {
      const { c } = setup();
      const id = c.add({
        content: "Fix this typo.",
        anchor: c.createAnchor(0, 5),
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(id);
      expect(list[0]!.content).toBe("Fix this typo.");
      expect(list[0]!.author).toBe("alice-pubkey");
      expect(list[0]!.data.status).toBe("open");
      expect(list[0]!.anchor).not.toBeNull();
      expect(list[0]!.anchor!.status).toBe("resolved");
      expect(list[0]!.parentId).toBeNull();
      expect(list[0]!.children).toHaveLength(0);
      c.destroy();
    });

    it("assigns unique IDs", () => {
      const { c } = setup();
      const id1 = c.add({
        content: "first",
        data: DEFAULT_DATA,
      });
      const id2 = c.add({
        content: "second",
        data: DEFAULT_DATA,
      });
      expect(id1).not.toBe(id2);
      c.destroy();
    });
  });

  describe("threading", () => {
    it("nests reply under parent", () => {
      const { c } = setup();
      const parentId = c.add({
        content: "Main comment",
        anchor: c.createAnchor(0, 5),
        data: DEFAULT_DATA,
      });
      c.add({
        content: "Reply",
        parentId,
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list).toHaveLength(1);
      expect(list[0]!.children).toHaveLength(1);
      expect(list[0]!.children[0]!.content).toBe("Reply");
      expect(list[0]!.children[0]!.parentId).toBe(parentId);
      expect(list[0]!.children[0]!.anchor).toBeNull();
      c.destroy();
    });

    it("throws on non-existent parentId", () => {
      const { c } = setup();
      expect(() =>
        c.add({
          content: "orphan reply",
          parentId: "nonexistent",
          data: DEFAULT_DATA,
        }),
      ).toThrow(/not found/);
      c.destroy();
    });

    it("throws on reply to a reply", () => {
      const { c } = setup();
      const parentId = c.add({
        content: "parent",
        anchor: c.createAnchor(0, 3),
        data: DEFAULT_DATA,
      });
      const replyId = c.add({
        content: "reply",
        parentId,
        data: DEFAULT_DATA,
      });
      expect(() =>
        c.add({
          content: "nested reply",
          parentId: replyId,
          data: DEFAULT_DATA,
        }),
      ).toThrow(/one-level/);
      c.destroy();
    });

    it("throws when reply has an anchor", () => {
      const { c } = setup();
      const parentId = c.add({
        content: "parent",
        anchor: c.createAnchor(0, 3),
        data: DEFAULT_DATA,
      });
      expect(() =>
        c.add({
          content: "reply with anchor",
          parentId,
          anchor: c.createAnchor(3, 5),
          data: DEFAULT_DATA,
        }),
      ).toThrow(/inherit parent anchor/);
      c.destroy();
    });

    it("sorts children by timestamp", () => {
      const { c } = setup();
      const parentId = c.add({
        content: "parent",
        data: DEFAULT_DATA,
      });
      c.add({
        content: "reply-1",
        parentId,
        data: DEFAULT_DATA,
      });
      c.add({
        content: "reply-2",
        parentId,
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      const kids = list[0]!.children;
      expect(kids).toHaveLength(2);
      expect(kids[0]!.ts).toBeLessThanOrEqual(kids[1]!.ts);
      c.destroy();
    });
  });

  describe("update", () => {
    it("updates app-defined data", () => {
      const { c } = setup();
      const id = c.add({
        content: "comment",
        data: DEFAULT_DATA,
      });

      c.update(id, {
        data: {
          status: "resolved",
          resolvedBy: "bob",
        },
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.data.status).toBe("resolved");
      expect(list[0]!.data.resolvedBy).toBe("bob");
      c.destroy();
    });

    it("partial update preserves other fields", () => {
      const { c } = setup();
      const id = c.add({
        content: "comment",
        data: DEFAULT_DATA,
      });

      c.update(id, {
        data: { status: "resolved" },
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.data.status).toBe("resolved");
      expect(list[0]!.data.resolvedBy).toBeNull();
      c.destroy();
    });

    it("throws on non-existent ID", () => {
      const { c } = setup();
      expect(() =>
        c.update("bad-id", {
          data: { status: "resolved" },
        }),
      ).toThrow(/not found/);
      c.destroy();
    });
  });

  describe("delete", () => {
    it("removes comment from feed", () => {
      const { c } = setup();
      const id = c.add({
        content: "to delete",
        data: DEFAULT_DATA,
      });
      expect(c.feed.getSnapshot()).toHaveLength(1);

      c.delete(id);
      expect(c.feed.getSnapshot()).toHaveLength(0);
      c.destroy();
    });

    it("no-op on non-existent ID", () => {
      const { c } = setup();
      expect(() => c.delete("nonexistent")).not.toThrow();
      c.destroy();
    });

    it("orphans children when parent deleted", () => {
      const { c } = setup();
      const parentId = c.add({
        content: "parent",
        data: DEFAULT_DATA,
      });
      c.add({
        content: "reply",
        parentId,
        data: DEFAULT_DATA,
      });

      c.delete(parentId);

      const list = c.feed.getSnapshot();
      expect(list).toHaveLength(0);
      c.destroy();
    });
  });

  describe("reactivity", () => {
    it("feed notifies on add", () => {
      const { c } = setup();
      const cb = vi.fn();
      c.feed.subscribe(cb);

      c.add({
        content: "new",
        data: DEFAULT_DATA,
      });
      expect(cb).toHaveBeenCalled();
      c.destroy();
    });

    it("feed notifies on delete", () => {
      const { c } = setup();
      const id = c.add({
        content: "will delete",
        data: DEFAULT_DATA,
      });
      const cb = vi.fn();
      c.feed.subscribe(cb);

      c.delete(id);
      expect(cb).toHaveBeenCalled();
      c.destroy();
    });

    it("feed notifies on content change", () => {
      const { c, contentDoc } = setup();
      c.add({
        content: "anchored",
        anchor: c.createAnchor(0, 5),
        data: DEFAULT_DATA,
      });
      const cb = vi.fn();
      c.feed.subscribe(cb);

      contentDoc.getText("default").insert(0, "prefix ");

      expect(cb).toHaveBeenCalled();
      c.destroy();
    });

    it("feed notifies on mapping change", () => {
      const { c, mappingFeed } = setup(42);

      c.add({
        content: "test",
        data: DEFAULT_DATA,
      });

      // Initially unverified.
      expect(c.feed.getSnapshot()[0]!.authorVerified).toBe(false);

      const cb = vi.fn();
      c.feed.subscribe(cb);

      // Update mapping — should trigger rebuild.
      mappingFeed._update(
        new Map([[42, { pubkey: "alice-pubkey", verified: true }]]),
      );

      expect(cb).toHaveBeenCalled();
      expect(c.feed.getSnapshot()[0]!.authorVerified).toBe(true);
      c.destroy();
    });

    it("unsubscribe stops notifications", () => {
      const { c } = setup();
      const cb = vi.fn();
      const unsub = c.feed.subscribe(cb);
      unsub();

      c.add({
        content: "after unsub",
        data: DEFAULT_DATA,
      });

      expect(cb).not.toHaveBeenCalled();
      c.destroy();
    });
  });

  describe("anchors", () => {
    it("resolves anchor positions", () => {
      const { c } = setup();
      c.add({
        content: "about hello",
        anchor: c.createAnchor(0, 5),
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      const anchor = list[0]!.anchor!;
      expect(anchor.status).toBe("resolved");
      if (anchor.status === "resolved") {
        expect(anchor.start).toBe(0);
        expect(anchor.end).toBe(5);
      }
      c.destroy();
    });

    it("null anchor for no-anchor comment", () => {
      const { c } = setup();
      c.add({
        content: "no anchor",
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.anchor).toBeNull();
      c.destroy();
    });

    it("anchor tracks position shifts", () => {
      const { c, contentDoc } = setup();
      c.add({
        content: "about world",
        anchor: c.createAnchor(6, 11),
        data: DEFAULT_DATA,
      });

      contentDoc.getText("default").insert(0, "hey ");

      const list = c.feed.getSnapshot();
      const anchor = list[0]!.anchor!;
      expect(anchor.status).toBe("resolved");
      if (anchor.status === "resolved") {
        expect(anchor.start).toBe(10);
        expect(anchor.end).toBe(15);
      }
      c.destroy();
    });
  });

  describe("author", () => {
    it("throws adding without author", () => {
      const commentsDoc = new Y.Doc();
      const contentDoc = new Y.Doc();
      const c = comments<TestData>(commentsDoc, contentDoc, {
        author: null,
        clientIdMapping: createFeed(new Map()),
      });

      expect(() =>
        c.add({
          content: "no author",
          data: DEFAULT_DATA,
        }),
      ).toThrow(/no author/);
      c.destroy();
    });

    it("authorVerified true with mapping", () => {
      const { c, mappingFeed } = setup(42);
      mappingFeed._update(
        new Map([[42, { pubkey: "alice-pubkey", verified: true }]]),
      );

      c.add({
        content: "verified",
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.authorVerified).toBe(true);
      c.destroy();
    });

    it("authorVerified false without mapping", () => {
      const { c } = setup();
      c.add({
        content: "unverified",
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.authorVerified).toBe(false);
      c.destroy();
    });

    it("authorVerified false when unverified", () => {
      const { c, mappingFeed } = setup(42);
      mappingFeed._update(
        new Map([
          [
            42,
            {
              pubkey: "alice-pubkey",
              verified: false,
            },
          ],
        ]),
      );

      c.add({
        content: "unverified sig",
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list[0]!.authorVerified).toBe(false);
      c.destroy();
    });
  });

  describe("destroy", () => {
    it("throws on add after destroy", () => {
      const { c } = setup();
      c.destroy();

      expect(() =>
        c.add({
          content: "after destroy",
          data: DEFAULT_DATA,
        }),
      ).toThrow(/destroyed/);
    });

    it("throws on createAnchor after destroy", () => {
      const { c } = setup();
      c.destroy();
      expect(() => c.createAnchor(0, 5)).toThrow(/destroyed/);
    });

    it("double destroy is safe", () => {
      const { c } = setup();
      c.destroy();
      expect(() => c.destroy()).not.toThrow();
    });

    it("stops observing after destroy", () => {
      const { c, commentsDoc } = setup();
      c.destroy();

      const cb = vi.fn();
      c.feed.subscribe(cb);

      const map = commentsDoc.getMap("comments") as Y.Map<Y.Map<unknown>>;
      map.set("manual", new Y.Map<unknown>());

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("XmlFragment content type", () => {
    it("anchors resolve against XmlFragment", () => {
      const commentsDoc = new Y.Doc();
      const contentDoc = new Y.Doc();
      const frag = contentDoc.getXmlFragment("default");
      frag.insert(0, [new Y.XmlText("para one")]);
      frag.insert(1, [new Y.XmlText("para two")]);
      frag.insert(2, [new Y.XmlText("para three")]);

      const c = comments<TestData>(commentsDoc, contentDoc, {
        author: "alice-pubkey",
        clientIdMapping: createFeed(new Map()),
        contentType: frag,
      });

      const id = c.add({
        content: "about first two paras",
        anchor: c.createAnchor(0, 2),
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      expect(list).toHaveLength(1);
      const anchor = list[0]!.anchor!;
      expect(anchor.status).toBe("resolved");
      if (anchor.status === "resolved") {
        expect(anchor.start).toBe(0);
        expect(anchor.end).toBe(2);
      }
      c.destroy();
    });

    it("defaults to Y.Text when contentType omitted", () => {
      const { c } = setup();
      c.add({
        content: "uses default text",
        anchor: c.createAnchor(0, 5),
        data: DEFAULT_DATA,
      });

      const list = c.feed.getSnapshot();
      const anchor = list[0]!.anchor!;
      expect(anchor.status).toBe("resolved");
      if (anchor.status === "resolved") {
        expect(anchor.start).toBe(0);
        expect(anchor.end).toBe(5);
      }
      c.destroy();
    });

    it("warns when contentType is not provided", () => {
      const prev = getLogLevel();
      setLogLevel("warn");
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { c } = setup();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[pokapali:comments]"),
        expect.stringContaining("No contentType provided"),
      );
      c.destroy();
      spy.mockRestore();
      setLogLevel(prev);
    });

    it("no warning when contentType is explicit", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const commentsDoc = new Y.Doc();
      const contentDoc = new Y.Doc();
      const text = contentDoc.getText("default");
      text.insert(0, "hello");
      const c = comments<TestData>(commentsDoc, contentDoc, {
        author: "alice-pubkey",
        clientIdMapping: createFeed(new Map()),
        contentType: text,
      });
      expect(spy).not.toHaveBeenCalledWith(
        expect.stringContaining("[pokapali:comments]"),
        expect.stringContaining("No contentType provided"),
      );
      c.destroy();
      spy.mockRestore();
    });

    it("throws when XmlFragment registered but no contentType", () => {
      const commentsDoc = new Y.Doc();
      const contentDoc = new Y.Doc();
      // Register "default" as XmlFragment
      const frag = contentDoc.getXmlFragment("default");
      frag.insert(0, [new Y.XmlText("paragraph")]);

      // Omit contentType — should throw
      expect(() =>
        comments<TestData>(commentsDoc, contentDoc, {
          author: "alice-pubkey",
          clientIdMapping: createFeed(new Map()),
        }),
      ).toThrow(/No contentType provided/);
    });
  });

  describe("CRDT sync", () => {
    it("syncs comments across two docs", () => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const contentDoc = new Y.Doc();
      contentDoc.getText("default").insert(0, "shared text");

      const c1 = comments<TestData>(doc1, contentDoc, {
        author: "alice",
        clientIdMapping: createFeed(new Map()),
      });
      const c2 = comments<TestData>(doc2, contentDoc, {
        author: "bob",
        clientIdMapping: createFeed(new Map()),
      });

      c1.add({
        content: "alice's comment",
        data: DEFAULT_DATA,
      });

      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      const list2 = c2.feed.getSnapshot();
      expect(list2).toHaveLength(1);
      expect(list2[0]!.content).toBe("alice's comment");

      c1.destroy();
      c2.destroy();
    });
  });
});
