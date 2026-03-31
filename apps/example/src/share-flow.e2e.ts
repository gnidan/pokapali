/**
 * Multi-browser share flow E2E tests.
 *
 * Each peer gets its own BrowserContext (independent
 * Helia node). Both connect through the test relay
 * started by globalSetup.
 */

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const RELAY_INFO_PATH = "/tmp/pokapali-test-relay.json";
const EDITOR_TIMEOUT = 8_000;
const SYNC_TIMEOUT = 30_000;

interface RelayInfo {
  multiaddr: string;
  peerId: string;
}

async function loadRelayInfo(): Promise<RelayInfo> {
  const raw = await readFile(RELAY_INFO_PATH, "utf-8");
  return JSON.parse(raw);
}

/**
 * Build a base URL with bootstrapPeers query param
 * so the app connects through the test relay.
 */
function appUrl(baseURL: string, relayAddr: string, path = "/"): string {
  const url = new URL(path, baseURL);
  url.searchParams.set("bootstrapPeers", relayAddr);
  return url.toString();
}

/**
 * Clear IDB for a page (same as App.e2e.ts).
 */
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

/**
 * Extract the write URL from the share panel.
 * Opens the panel, reads the input title attribute
 * (which has the full untruncated URL), then closes.
 */
async function getWriteUrl(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.locator("[data-testid='share-toggle']").click();
  await expect(page.locator("[data-testid='share-panel']")).toBeVisible();

  // The CopyRow input's title has the full URL.
  // Find the share-card that contains the "Write"
  // label and read its input title.
  const writeCard = page.locator(".share-card", {
    has: page.locator(".share-card-label", { hasText: "Write" }),
  });
  const input = writeCard.locator("input");
  const url = await input.getAttribute("title");

  // Close the panel.
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

test.describe("share flow", () => {
  // These tests need extra time for relay discovery
  // and WebRTC connection.
  test.slow();

  test("Alice creates doc, Bob opens shared URL", async ({ browser }) => {
    const relay = await loadRelayInfo();

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();

    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      // Alice: create doc with relay bootstrap.
      const baseURL = test.info().project.use.baseURL!;
      await alice.goto(appUrl(baseURL, relay.multiaddr));
      await clearIDB(alice);
      await alice.goto(appUrl(baseURL, relay.multiaddr));

      await alice
        .getByRole("button", {
          name: "Create new document",
        })
        .click();
      await expect(alice.locator(".tiptap")).toBeVisible({
        timeout: EDITOR_TIMEOUT,
      });

      // Alice types content.
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("Hello from Alice");

      // Get the write URL from share panel.
      const writeUrl = await getWriteUrl(alice);

      // Bob: open the write URL with relay bootstrap.
      // Append bootstrapPeers to the doc URL.
      const bobUrl = new URL(writeUrl);
      bobUrl.searchParams.set("bootstrapPeers", relay.multiaddr);
      await bob.goto(bobUrl.toString());
      await clearIDB(bob);
      await bob.goto(bobUrl.toString());

      await expect(bob.locator(".tiptap")).toBeVisible({
        timeout: EDITOR_TIMEOUT,
      });

      // Wait for peer connection before checking
      // content sync.
      await waitForPeerConnection(alice);
      await waitForPeerConnection(bob);

      // Wait for Bob to see Alice's content via
      // relay sync.
      await expect(bob.locator(".tiptap")).toContainText("Hello from Alice", {
        timeout: SYNC_TIMEOUT,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("real-time bidirectional sync", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();

    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      // Alice creates a doc.
      await alice.goto(appUrl(baseURL, relay.multiaddr));
      await clearIDB(alice);
      await alice.goto(appUrl(baseURL, relay.multiaddr));

      await alice
        .getByRole("button", {
          name: "Create new document",
        })
        .click();
      await expect(alice.locator(".tiptap")).toBeVisible({
        timeout: EDITOR_TIMEOUT,
      });

      // Get write URL for Bob.
      const writeUrl = await getWriteUrl(alice);
      const bobUrl = new URL(writeUrl);
      bobUrl.searchParams.set("bootstrapPeers", relay.multiaddr);

      // Bob opens the doc.
      await bob.goto(bobUrl.toString());
      await clearIDB(bob);
      await bob.goto(bobUrl.toString());
      await expect(bob.locator(".tiptap")).toBeVisible({
        timeout: EDITOR_TIMEOUT,
      });

      // Wait for peer connection before typing.
      await waitForPeerConnection(alice);
      await waitForPeerConnection(bob);

      // Alice types — Bob sees it.
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("Alice says hi");
      await expect(bob.locator(".tiptap")).toContainText("Alice says hi", {
        timeout: SYNC_TIMEOUT,
      });

      // Bob types — Alice sees it.
      await bob.locator(".tiptap").click();
      await bob.keyboard.type(" Bob replies");
      await expect(alice.locator(".tiptap")).toContainText("Bob replies", {
        timeout: SYNC_TIMEOUT,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
