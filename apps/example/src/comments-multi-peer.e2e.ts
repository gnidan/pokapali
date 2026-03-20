/**
 * Multi-peer comment sync E2E tests.
 *
 * Tests that comments created by one peer sync to
 * another peer connected through the test relay.
 * Uses separate browser contexts to simulate
 * independent peers.
 *
 * #230
 */

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const RELAY_INFO_PATH = "/tmp/pokapali-test-relay.json";
const EDITOR_TIMEOUT = 8_000;
const SYNC_TIMEOUT = 15_000;

interface RelayInfo {
  multiaddr: string;
  peerId: string;
}

async function loadRelayInfo(): Promise<RelayInfo> {
  const raw = await readFile(RELAY_INFO_PATH, "utf-8");
  return JSON.parse(raw);
}

function appUrl(baseURL: string, relayAddr: string, path = "/"): string {
  const url = new URL(path, baseURL);
  url.searchParams.set("bootstrapPeers", relayAddr);
  return url.toString();
}

async function clearIDB(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    if ("databases" in indexedDB) {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    }
  });
}

async function createDocViaRelay(
  page: import("@playwright/test").Page,
  baseURL: string,
  relayAddr: string,
) {
  await page.goto(appUrl(baseURL, relayAddr));
  await clearIDB(page);
  await page.goto(appUrl(baseURL, relayAddr));
  await page.getByRole("button", { name: "Create new document" }).click();
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

async function openDocViaRelay(
  page: import("@playwright/test").Page,
  writeUrl: string,
  relayAddr: string,
) {
  const url = new URL(writeUrl);
  url.searchParams.set("bootstrapPeers", relayAddr);
  await page.goto(url.toString());
  await clearIDB(page);
  await page.goto(url.toString());
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

async function getWriteUrl(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.locator("[data-testid='share-toggle']").click();
  await expect(page.locator("[data-testid='share-panel']")).toBeVisible();

  const writeCard = page.locator(".share-card", {
    has: page.locator(".share-card-label", {
      hasText: "Write",
    }),
  });
  const url = await writeCard.locator("input").getAttribute("title");

  await page.locator("[data-testid='share-toggle']").click();

  if (!url) throw new Error("Write URL not found");
  return url;
}

/**
 * Wait for two peers to see each other via awareness.
 */
async function waitForPeerConnection(page: import("@playwright/test").Page) {
  await expect(page.locator("[data-testid='cs-users-count']")).toContainText(
    "2",
    { timeout: SYNC_TIMEOUT },
  );
}

/**
 * Type text, select all, click the comment popover
 * button, fill the comment input, and submit.
 */
async function createComment(
  page: import("@playwright/test").Page,
  editorText: string,
  commentText: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(editorText);
  await page.keyboard.press("Meta+a");

  await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
    timeout: 3_000,
  });
  await page.locator("[data-testid='add-comment-btn']").click();

  await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
    timeout: 3_000,
  });

  const input = page.locator(".cs-new-comment [data-testid='comment-input']");
  await input.fill(commentText);
  await page.locator(".cs-new-comment [data-testid='comment-submit']").click();

  await expect(
    page
      .locator("[data-testid='comment-item']")
      .filter({ hasText: commentText }),
  ).toBeVisible({ timeout: 3_000 });
}

test.describe("multi-peer comment sync", () => {
  test.slow();

  test("comment created by one peer syncs to another", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      // Alice creates doc, get write URL before Bob.
      await createDocViaRelay(alice, baseURL, relay.multiaddr);
      const writeUrl = await getWriteUrl(alice);

      // Bob joins the same document.
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Wait for both peers to connect via awareness.
      await waitForPeerConnection(alice);
      await waitForPeerConnection(bob);

      // Now Alice creates a comment — Bob is already
      // connected so CRDT sync will propagate it.
      await createComment(alice, "Shared document text", "Alice's comment");

      // Bob should see Alice's text via CRDT sync.
      await expect(bob.locator(".tiptap")).toContainText(
        "Shared document text",
        {
          timeout: SYNC_TIMEOUT,
        },
      );

      // Bob opens the comments sidebar.
      await bob.locator(".toggle-comments").click();
      await expect(bob.locator("[data-testid='comment-sidebar']")).toBeVisible({
        timeout: 3_000,
      });

      // Bob should see Alice's comment after sync.
      await expect(
        bob
          .locator("[data-testid='comment-item']")
          .filter({ hasText: "Alice's comment" }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("comment anchor highlight syncs to second peer", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      await createDocViaRelay(alice, baseURL, relay.multiaddr);
      const writeUrl = await getWriteUrl(alice);
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Wait for peer connection.
      await waitForPeerConnection(alice);
      await waitForPeerConnection(bob);

      // Alice creates a comment with anchored text.
      await createComment(alice, "Highlighted anchor text", "Anchor sync test");

      // Verify Alice has the anchor highlight.
      await expect(alice.locator(".tiptap .comment-anchor")).toBeVisible({
        timeout: 3_000,
      });

      // Bob should see the comment anchor highlight
      // after Yjs sync propagates the marks.
      await expect(bob.locator(".tiptap .comment-anchor")).toBeVisible({
        timeout: SYNC_TIMEOUT,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("reply from second peer syncs back to first", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      // Alice creates doc, Bob joins.
      await createDocViaRelay(alice, baseURL, relay.multiaddr);
      const writeUrl = await getWriteUrl(alice);
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Wait for peers to connect.
      await waitForPeerConnection(alice);
      await waitForPeerConnection(bob);

      // Alice creates a comment.
      await createComment(alice, "Discussion text", "Alice starts the thread");

      // Bob opens sidebar and waits for comment sync.
      await bob.locator(".toggle-comments").click();
      await expect(bob.locator("[data-testid='comment-sidebar']")).toBeVisible({
        timeout: 3_000,
      });

      await expect(
        bob.locator("[data-testid='comment-item']").filter({
          hasText: "Alice starts the thread",
        }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });

      // Bob replies.
      await bob.locator("[data-testid='reply-btn']").first().click();
      const replyInput = bob
        .locator(".cs-reply-input-wrap")
        .locator("[data-testid='comment-input']");
      await expect(replyInput).toBeVisible();
      await replyInput.fill("Bob replies here");
      await bob
        .locator(".cs-reply-input-wrap")
        .locator("[data-testid='comment-submit']")
        .click();

      // Bob should see both items.
      await expect(bob.locator("[data-testid='comment-item']")).toHaveCount(2, {
        timeout: 3_000,
      });

      // Alice should see Bob's reply after sync.
      // Alice's sidebar is still open from
      // createComment.
      await expect(
        alice
          .locator("[data-testid='comment-item']")
          .filter({ hasText: "Bob replies here" }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
