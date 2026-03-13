import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { verifyAuthor } from "./verify.js";
import type { ClientIdMapping } from "./verify.js";

function makeDoc(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

function makeEntry(doc: Y.Doc, key: string): Y.Map<unknown> {
  const root = doc.getMap("comments") as Y.Map<Y.Map<unknown>>;
  const entry = new Y.Map<unknown>();
  root.set(key, entry);
  return root.get(key) as Y.Map<unknown>;
}

/** Helper to build a mapping with verified entries. */
function mapping(...entries: [number, string][]): ClientIdMapping {
  return new Map(
    entries.map(([id, pubkey]) => [id, { pubkey, verified: true }]),
  );
}

describe("verifyAuthor", () => {
  it("returns true when mapping matches", () => {
    const doc = makeDoc(42);
    const entry = makeEntry(doc, "c1");

    expect(
      verifyAuthor(entry, "alice-pubkey", mapping([42, "alice-pubkey"])),
    ).toBe(true);
  });

  it("returns false when pubkey mismatches", () => {
    const doc = makeDoc(42);
    const entry = makeEntry(doc, "c1");

    expect(
      verifyAuthor(entry, "bob-pubkey", mapping([42, "alice-pubkey"])),
    ).toBe(false);
  });

  it("returns false when clientID unmapped", () => {
    const doc = makeDoc(42);
    const entry = makeEntry(doc, "c1");

    expect(verifyAuthor(entry, "alice-pubkey", mapping())).toBe(false);
  });

  it("returns false for empty mapping", () => {
    const doc = makeDoc(99);
    const entry = makeEntry(doc, "c1");

    expect(verifyAuthor(entry, "anyone", mapping())).toBe(false);
  });

  it("returns false when sig not verified", () => {
    const doc = makeDoc(42);
    const entry = makeEntry(doc, "c1");

    const unverified: ClientIdMapping = new Map([
      [42, { pubkey: "alice", verified: false }],
    ]);

    expect(verifyAuthor(entry, "alice", unverified)).toBe(false);
  });

  it("verifies across synced docs", () => {
    const doc1 = makeDoc(10);
    const doc2 = makeDoc(20);

    // Alice writes on doc1.
    const root1 = doc1.getMap("comments") as Y.Map<Y.Map<unknown>>;
    root1.set("alice-comment", new Y.Map<unknown>());

    // Sync doc1 → doc2.
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // Bob writes on doc2.
    const root2 = doc2.getMap("comments") as Y.Map<Y.Map<unknown>>;
    root2.set("bob-comment", new Y.Map<unknown>());

    // Sync doc2 → doc1.
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

    const m = mapping([10, "alice"], [20, "bob"]);

    // Alice's comment — clientID 10.
    const aliceEntry = root2.get("alice-comment")!;
    expect(verifyAuthor(aliceEntry, "alice", m)).toBe(true);
    expect(verifyAuthor(aliceEntry, "bob", m)).toBe(false);

    // Bob's comment — clientID 20.
    const bobEntry = root2.get("bob-comment")!;
    expect(verifyAuthor(bobEntry, "bob", m)).toBe(true);
    expect(verifyAuthor(bobEntry, "alice", m)).toBe(false);
  });
});
