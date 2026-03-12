/**
 * Tests for create-doc.ts exported functions.
 *
 * createDoc() itself is tested via index.test.ts
 * (integration). This file tests the exported
 * helper: populateMeta().
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { populateMeta } from "./create-doc.js";

describe("populateMeta", () => {
  it("adds signing key to canPushSnapshots", () => {
    const metaDoc = new Y.Doc();
    const pubKey = new Uint8Array([1, 2, 3]);

    populateMeta(metaDoc, pubKey, {});

    const arr = metaDoc.getArray<Uint8Array>("canPushSnapshots");
    expect(arr.length).toBe(1);
    expect(arr.get(0)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("populates authorized channels with keys", () => {
    const metaDoc = new Y.Doc();
    const pubKey = new Uint8Array([1]);
    const channelKeys = {
      content: new Uint8Array([10, 20]),
      comments: new Uint8Array([30, 40]),
    };

    populateMeta(metaDoc, pubKey, channelKeys);

    const authorized = metaDoc.getMap("authorized");
    expect(authorized.size).toBe(2);

    const contentArr = authorized.get("content") as Y.Array<Uint8Array>;
    expect(contentArr).toBeInstanceOf(Y.Array);
    expect(contentArr.length).toBe(1);
    expect(contentArr.get(0)).toEqual(new Uint8Array([10, 20]));

    const commentsArr = authorized.get("comments") as Y.Array<Uint8Array>;
    expect(commentsArr.length).toBe(1);
    expect(commentsArr.get(0)).toEqual(new Uint8Array([30, 40]));
  });

  it("handles empty channel keys", () => {
    const metaDoc = new Y.Doc();
    const pubKey = new Uint8Array([5]);

    populateMeta(metaDoc, pubKey, {});

    const authorized = metaDoc.getMap("authorized");
    expect(authorized.size).toBe(0);

    const arr = metaDoc.getArray<Uint8Array>("canPushSnapshots");
    expect(arr.length).toBe(1);
  });

  it("handles single channel", () => {
    const metaDoc = new Y.Doc();
    const pubKey = new Uint8Array([7]);

    populateMeta(metaDoc, pubKey, {
      main: new Uint8Array([99]),
    });

    const authorized = metaDoc.getMap("authorized");
    expect(authorized.size).toBe(1);
    expect(authorized.has("main")).toBe(true);
  });
});
