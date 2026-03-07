import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import {
  createSubdocManager,
  SNAPSHOT_ORIGIN,
  INDEXEDDB_ORIGIN,
} from "./index.js";

describe("@pokapali/subdocs", () => {
  const ipns = "k51test123";
  const namespaces = ["doc", "awareness"];

  it("creates docs for each namespace", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    expect(mgr.subdoc("doc"))
      .toBeInstanceOf(Y.Doc);
    expect(mgr.subdoc("awareness"))
      .toBeInstanceOf(Y.Doc);
    mgr.destroy();
  });

  it("assigns deterministic GUIDs", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    expect(mgr.subdoc("doc").guid)
      .toBe(`${ipns}:doc`);
    expect(mgr.subdoc("awareness").guid)
      .toBe(`${ipns}:awareness`);
    expect(mgr.metaDoc.guid)
      .toBe(`${ipns}:_meta`);
    mgr.destroy();
  });

  it("throws for unknown namespace", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    expect(() => mgr.subdoc("nope"))
      .toThrow("Unknown namespace: nope");
    mgr.destroy();
  });

  it("metaDoc exists and is a Y.Doc", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    expect(mgr.metaDoc)
      .toBeInstanceOf(Y.Doc);
    expect(mgr.metaDoc.guid)
      .toBe(`${ipns}:_meta`);
    mgr.destroy();
  });

  it("encodeAll / applySnapshot round-trip",
    () => {
      const mgr1 = createSubdocManager(
        ipns, namespaces
      );
      mgr1.subdoc("doc")
        .getMap("root").set("key", "value");
      mgr1.subdoc("awareness")
        .getArray("items").push(["a", "b"]);

      const snapshot = mgr1.encodeAll();

      const mgr2 = createSubdocManager(
        ipns, namespaces
      );
      mgr2.applySnapshot(snapshot);

      expect(
        mgr2.subdoc("doc")
          .getMap("root").get("key")
      ).toBe("value");
      expect(
        mgr2.subdoc("awareness")
          .getArray("items").toArray()
      ).toEqual(["a", "b"]);

      mgr1.destroy();
      mgr2.destroy();
    }
  );

  it("applySnapshot does not set isDirty",
    () => {
      const mgr1 = createSubdocManager(
        ipns, namespaces
      );
      mgr1.subdoc("doc")
        .getMap("root").set("x", 1);
      const snapshot = mgr1.encodeAll();

      const mgr2 = createSubdocManager(
        ipns, namespaces
      );
      mgr2.applySnapshot(snapshot);
      expect(mgr2.isDirty).toBe(false);

      mgr1.destroy();
      mgr2.destroy();
    }
  );

  it("isDirty tracking", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    expect(mgr.isDirty).toBe(false);

    mgr.subdoc("doc")
      .getMap("root").set("a", 1);
    expect(mgr.isDirty).toBe(true);

    mgr.encodeAll();
    expect(mgr.isDirty).toBe(false);

    mgr.subdoc("awareness")
      .getArray("items").push(["c"]);
    expect(mgr.isDirty).toBe(true);

    mgr.destroy();
  });

  it("dirty event fires on false->true " +
    "transition only", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    const cb = vi.fn();
    mgr.on("dirty", cb);

    mgr.subdoc("doc")
      .getMap("root").set("a", 1);
    expect(cb).toHaveBeenCalledTimes(1);

    // Already dirty, should not fire again
    mgr.subdoc("doc")
      .getMap("root").set("b", 2);
    expect(cb).toHaveBeenCalledTimes(1);

    // Reset via encodeAll, then edit again
    mgr.encodeAll();
    mgr.subdoc("doc")
      .getMap("root").set("c", 3);
    expect(cb).toHaveBeenCalledTimes(2);

    mgr.destroy();
  });

  it("off removes dirty listener", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    const cb = vi.fn();
    mgr.on("dirty", cb);
    mgr.off("dirty", cb);

    mgr.subdoc("doc")
      .getMap("root").set("a", 1);
    expect(cb).not.toHaveBeenCalled();

    mgr.destroy();
  });

  it("destroy is idempotent", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    mgr.destroy();
    expect(() => mgr.destroy()).not.toThrow();
  });

  it("destroy cleans up, isDirty is false",
    () => {
      const mgr = createSubdocManager(
        ipns, namespaces
      );
      mgr.subdoc("doc")
        .getMap("root").set("a", 1);
      expect(mgr.isDirty).toBe(true);

      mgr.destroy();
      expect(mgr.isDirty).toBe(false);
    }
  );

  it("whenLoaded resolves", async () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    await expect(mgr.whenLoaded)
      .resolves.toBeUndefined();
    mgr.destroy();
  });

  it("primaryNamespace defaults to first",
    () => {
      const mgr1 = createSubdocManager(
        ipns, namespaces
      );
      expect(mgr1.subdoc("doc"))
        .toBeInstanceOf(Y.Doc);

      const mgr2 = createSubdocManager(
        ipns,
        namespaces,
        { primaryNamespace: "awareness" }
      );
      expect(mgr2.subdoc("awareness"))
        .toBeInstanceOf(Y.Doc);

      mgr1.destroy();
      mgr2.destroy();
    }
  );

  it("INDEXEDDB_ORIGIN updates do not set " +
    "isDirty", () => {
    const mgr = createSubdocManager(
      ipns, namespaces
    );
    const doc = mgr.subdoc("doc");

    doc.transact(() => {
      doc.getMap("root").set("persisted", true);
    }, INDEXEDDB_ORIGIN);

    expect(mgr.isDirty).toBe(false);
    mgr.destroy();
  });
});
