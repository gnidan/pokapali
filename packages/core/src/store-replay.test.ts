/**
 * Integration test: Store persist → reload → Y.Doc
 * replay cycle.
 *
 * Exercises the exact code path used by create-doc.ts:
 *   1. Local edit → Y.Doc update → Edit.create →
 *      Store.append (the "persistEdit" flow)
 *   2. Close Store → reopen → Store.load → Y.applyUpdate
 *      (the "replay" flow)
 *
 * Uses real Store (fake-indexeddb), real Y.js, and
 * real @pokapali/document types. No mocks.
 */
import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { Edit, epochMeasured } from "@pokapali/document";
import { measureTree } from "@pokapali/finger-tree";
import { Channel } from "@pokapali/document";
import { Store } from "@pokapali/store";

const STORE_ORIGIN = "store-replay";

let nextId = 0;
function freshId(): string {
  return `replay-test-${++nextId}-${Math.random()}`;
}

describe("Store persist → replay cycle", () => {
  it("Y.Doc text round-trips through Store", async () => {
    const appId = freshId();
    const ipnsName = "test-ipns-name";
    const channelName = "content";

    // --- Session 1: create, edit, persist ---

    const s1 = await Store.create(appId);
    const storeDoc1 = s1.documents.get(ipnsName);
    const ydoc1 = new Y.Doc();
    const channel1 = Channel.create(channelName);

    // Capture Y.Doc updates and persist them (mimics
    // the editHandler + persistEdit in create-doc.ts)
    const editsToStore: Array<{
      epochIndex: number;
      edit: ReturnType<typeof Edit.create>;
    }> = [];

    ydoc1.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin != null) return; // only local edits
      const edit = Edit.create({
        payload: update,
        timestamp: Date.now(),
        author: "test-author",
        channel: channelName,
        origin: "local",
        signature: new Uint8Array(),
      });
      channel1.appendEdit(edit);

      const summary = measureTree(epochMeasured, channel1.tree);
      const tipIndex = summary.epochCount - 1;
      editsToStore.push({ epochIndex: tipIndex, edit });
    });

    // Make some edits
    ydoc1.getText("body").insert(0, "hello world");
    ydoc1.getText("body").insert(5, ",");
    ydoc1.getMap("meta").set("title", "Test Doc");

    // Persist all captured edits
    for (const { epochIndex, edit } of editsToStore) {
      await storeDoc1.history(channelName).append(epochIndex, edit);
    }

    // Verify content is in Y.Doc
    expect(ydoc1.getText("body").toString()).toBe("hello, world");
    expect(ydoc1.getMap("meta").get("title")).toBe("Test Doc");

    s1.close();

    // --- Session 2: reopen, load, replay ---

    const s2 = await Store.create(appId);
    const storeDoc2 = s2.documents.get(ipnsName);
    const ydoc2 = new Y.Doc();

    // Replay (mimics the Store replay in create-doc.ts)
    const epochs = await storeDoc2.history(channelName).load();
    expect(epochs.length).toBeGreaterThan(0);

    let editCount = 0;
    for (const epoch of epochs) {
      for (const edit of epoch.edits) {
        Y.applyUpdate(ydoc2, edit.payload, STORE_ORIGIN);
        editCount++;
      }
    }
    expect(editCount).toBeGreaterThan(0);

    // Verify content was restored
    expect(ydoc2.getText("body").toString()).toBe("hello, world");
    expect(ydoc2.getMap("meta").get("title")).toBe("Test Doc");

    s2.close();
  });

  it(
    "replay with STORE_ORIGIN does not trigger " + "null-origin handlers",
    async () => {
      const appId = freshId();
      const ipnsName = "test-ipns-2";
      const channelName = "content";

      // Session 1: persist an edit
      const s1 = await Store.create(appId);
      const ydoc1 = new Y.Doc();
      const edit = await new Promise<ReturnType<typeof Edit.create>>(
        (resolve) => {
          ydoc1.on("update", (update: Uint8Array, origin: unknown) => {
            if (origin != null) return;
            resolve(
              Edit.create({
                payload: update,
                timestamp: Date.now(),
                author: "a",
                channel: channelName,
                origin: "local",
                signature: new Uint8Array(),
              }),
            );
          });
          ydoc1.getText("body").insert(0, "test");
        },
      );
      await s1.documents.get(ipnsName).history(channelName).append(0, edit);
      s1.close();

      // Session 2: replay and check origin filtering
      const s2 = await Store.create(appId);
      const ydoc2 = new Y.Doc();
      let nullOriginFired = false;
      ydoc2.on("update", (_: Uint8Array, origin: unknown) => {
        if (origin == null) nullOriginFired = true;
      });

      const epochs = await s2.documents
        .get(ipnsName)
        .history(channelName)
        .load();
      for (const epoch of epochs) {
        for (const e of epoch.edits) {
          Y.applyUpdate(ydoc2, e.payload, STORE_ORIGIN);
        }
      }

      expect(nullOriginFired).toBe(false);
      expect(ydoc2.getText("body").toString()).toBe("test");
      s2.close();
    },
  );

  it("fire-and-forget persist completes before " + "close", async () => {
    const appId = freshId();
    const ipnsName = "test-ipns-3";
    const channelName = "content";

    const store = await Store.create(appId);
    const storeDoc = store.documents.get(ipnsName);
    const ydoc = new Y.Doc();
    const channel = Channel.create(channelName);

    // Fire-and-forget persist (no await), same as
    // persistEdit in create-doc.ts
    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin != null) return;
      const edit = Edit.create({
        payload: update,
        timestamp: Date.now(),
        author: "a",
        channel: channelName,
        origin: "local",
        signature: new Uint8Array(),
      });
      channel.appendEdit(edit);
      const summary = measureTree(epochMeasured, channel.tree);
      const tipIndex = summary.epochCount - 1;
      // Fire and forget — no await
      storeDoc
        .history(channelName)
        .append(tipIndex, edit)
        .catch(() => {});
    });

    ydoc.getText("body").insert(0, "async persist");

    // Flush microtasks (IDB writes in fake-indexeddb
    // complete on microtask boundaries)
    await new Promise((r) => setTimeout(r, 0));

    store.close();

    // Reopen and verify
    const s2 = await Store.create(appId);
    const epochs = await s2.documents.get(ipnsName).history(channelName).load();

    let total = 0;
    const ydoc2 = new Y.Doc();
    for (const ep of epochs) {
      for (const e of ep.edits) {
        Y.applyUpdate(ydoc2, e.payload, STORE_ORIGIN);
        total++;
      }
    }

    expect(total).toBeGreaterThan(0);
    expect(ydoc2.getText("body").toString()).toBe("async persist");
    s2.close();
  });
});
