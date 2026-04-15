/**
 * Tier 2 multi-peer integration tests using
 * @pokapali/test-utils for synchronous Yjs sync.
 *
 * Tests collaboration scenarios that would be flaky
 * with two real Playwright browser contexts (DHT
 * discovery ~30s, WebRTC handshake). Instead we test
 * at the Yjs layer where sync is deterministic.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import type { CodecSurface } from "@pokapali/codec";
import {
  createTestNetwork,
  type TestNetwork,
} from "../../../packages/test-utils/src/index.js";
import { comments } from "../../../packages/comments/src/index.js";
import { createFeed } from "../../../packages/comments/src/feed.js";

/** Wrap a raw Y.Doc as a minimal CodecSurface stub
 *  for test-utils peers. */
function wrapDoc(doc: Y.Doc): CodecSurface {
  return { handle: doc } as CodecSurface;
}

describe("multi-peer collaboration", () => {
  let net: TestNetwork;

  afterEach(() => {
    net?.destroy();
  });

  it("text typed by one peer appears " + "on the other", () => {
    net = createTestNetwork({
      channels: ["content"],
    });
    const alice = net.peer("alice");
    const bob = net.peer("bob");

    const aliceContent = alice.channel("content");
    const aliceText = aliceContent.getText("default");
    aliceText.insert(0, "Hello from Alice");

    const bobContent = bob.channel("content");
    const bobText = bobContent.getText("default");
    expect(bobText.toString()).toBe("Hello from Alice");
    expect(net.isConverged()).toBe(true);
  });

  it("concurrent edits from both peers merge", () => {
    net = createTestNetwork({
      channels: ["content"],
    });
    const alice = net.peer("alice");
    const bob = net.peer("bob");

    // Disconnect so edits are concurrent
    net.disconnect("alice", "bob");

    const aliceText = alice.channel("content").getText("default");
    const bobText = bob.channel("content").getText("default");

    aliceText.insert(0, "Alice");
    bobText.insert(0, "Bob");

    // Not converged while disconnected
    expect(net.isConverged()).toBe(false);

    // Reconnect — edits merge
    net.reconnect("alice", "bob");
    expect(net.isConverged()).toBe(true);

    // Both peers see combined text
    const merged = aliceText.toString();
    expect(merged).toContain("Alice");
    expect(merged).toContain("Bob");
    expect(bobText.toString()).toBe(merged);
  });

  it("comment added by one peer visible " + "to the other", () => {
    net = createTestNetwork({
      channels: ["content", "comments"],
    });
    const alice = net.peer("alice");
    const bob = net.peer("bob");

    // Set up content with text to anchor on
    const aliceContent = alice.channel("content");
    aliceContent.getText("default").insert(0, "Some document text");

    // Set up comments instances
    const emptyMapping = createFeed(new Map(), () => false);

    const aliceComments = comments(
      wrapDoc(alice.channel("comments")),
      wrapDoc(alice.channel("content")),
      {
        author: "alice-pubkey",
        clientIdMapping: emptyMapping,
      },
    );

    const bobComments = comments(
      wrapDoc(bob.channel("comments")),
      wrapDoc(bob.channel("content")),
      {
        author: "bob-pubkey",
        clientIdMapping: emptyMapping,
      },
    );

    // Alice adds a comment with anchor
    const anchor = aliceComments.createAnchor(0, 4);
    aliceComments.add({
      content: "Nice intro!",
      anchor,
      data: {},
    });

    // Bob should see it
    const bobList = bobComments.feed.getSnapshot();
    expect(bobList).toHaveLength(1);
    expect(bobList[0].content).toBe("Nice intro!");
    expect(bobList[0].author).toBe("alice-pubkey");

    aliceComments.destroy();
    bobComments.destroy();
  });

  it("reply from second peer visible to first", () => {
    net = createTestNetwork({
      channels: ["content", "comments"],
    });
    const alice = net.peer("alice");
    const bob = net.peer("bob");

    alice.channel("content").getText("default").insert(0, "Document text here");

    const emptyMapping = createFeed(new Map(), () => false);

    const aliceComments = comments(
      wrapDoc(alice.channel("comments")),
      wrapDoc(alice.channel("content")),
      {
        author: "alice-pubkey",
        clientIdMapping: emptyMapping,
      },
    );

    const bobComments = comments(
      wrapDoc(bob.channel("comments")),
      wrapDoc(bob.channel("content")),
      {
        author: "bob-pubkey",
        clientIdMapping: emptyMapping,
      },
    );

    // Alice posts a comment
    const anchor = aliceComments.createAnchor(0, 8);
    const commentId = aliceComments.add({
      content: "What about this?",
      anchor,
      data: {},
    });

    // Bob replies
    bobComments.add({
      content: "Looks good to me",
      parentId: commentId,
      data: {},
    });

    // Alice sees the reply
    const aliceList = aliceComments.feed.getSnapshot();
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0].children).toHaveLength(1);
    expect(aliceList[0].children![0].content).toBe("Looks good to me");
    expect(aliceList[0].children![0].author).toBe("bob-pubkey");

    aliceComments.destroy();
    bobComments.destroy();
  });
});
