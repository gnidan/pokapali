/**
 * Multi-peer editing E2E tests.
 *
 * Tests concurrent editing by multiple browser
 * contexts connected through the test relay.
 * Verifies CRDT convergence and user count.
 */

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const RELAY_INFO_PATH =
  process.env.RELAY_INFO_PATH || "/tmp/pokapali-test-relay.json";
const EDITOR_TIMEOUT = 8_000;
const SYNC_TIMEOUT = 30_000;
// Relay-connected publish (IPFS snapshot) is slow
// on resource-constrained CI runners.
const PUBLISH_TIMEOUT = 45_000;

interface RelayInfo {
  multiaddr: string;
  peerId: string;
}

async function loadRelayInfo(): Promise<RelayInfo> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readFile(RELAY_INFO_PATH, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error("unreachable");
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
 * Create a doc on a page connected through the relay.
 * Returns with the editor visible.
 */
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

/**
 * Open an existing doc URL on a page, with relay
 * bootstrap. Returns with the editor visible.
 */
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

/**
 * Verify document sync is working by having `writer`
 * type a canary token and confirming `reader` sees it.
 * Awareness (user count) connects before WebRTC data
 * channels are ready — this ensures actual CRDT sync
 * is operational before the test proceeds.
 */
async function waitForDocSync(
  writer: import("@playwright/test").Page,
  reader: import("@playwright/test").Page,
  canary: string,
) {
  await writer.locator(".tiptap").click();
  await writer.keyboard.type(canary);
  await expect(reader.locator(".tiptap")).toContainText(canary, {
    timeout: SYNC_TIMEOUT,
  });
  // Clean up canary: select all and delete on writer.
  await writer.keyboard.press("ControlOrMeta+a");
  await writer.keyboard.press("Backspace");
  // Wait for delete to propagate.
  await expect(reader.locator(".tiptap")).not.toContainText(canary, {
    timeout: SYNC_TIMEOUT,
  });
}

test.describe("multi-peer editing", () => {
  test.slow();

  test("concurrent edits converge", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    // Diagnostic: capture P2P logs from both browsers
    alice.on("console", (msg) => {
      if (msg.text().includes("[P2P-DIAG]")) {
        console.log(`[ALICE] ${msg.text()}`);
      }
    });
    bob.on("console", (msg) => {
      if (msg.text().includes("[P2P-DIAG]")) {
        console.log(`[BOB] ${msg.text()}`);
      }
    });

    try {
      await createDocViaRelay(alice, baseURL, relay.multiaddr);
      const writeUrl = await getWriteUrl(alice);
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Wait for awareness (peer presence) first.
      await expect(
        alice.locator("[data-testid='cs-users-count']"),
      ).toContainText("2 users editing", {
        timeout: SYNC_TIMEOUT,
      });
      await expect(bob.locator("[data-testid='cs-users-count']")).toContainText(
        "2 users editing",
        {
          timeout: SYNC_TIMEOUT,
        },
      );

      // Awareness connects before WebRTC data channels
      // are ready. Verify actual doc sync works before
      // proceeding with the real test.
      await waitForDocSync(alice, bob, "SYNC_CHECK");

      // Both type simultaneously into the same doc.
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("Alice-content");

      await bob.locator(".tiptap").click();
      await bob.keyboard.type("Bob-content");

      // Both should eventually see both pieces of
      // content (CRDT convergence). Order may vary.
      await expect(alice.locator(".tiptap")).toContainText("Alice-content", {
        timeout: SYNC_TIMEOUT,
      });
      await expect(alice.locator(".tiptap")).toContainText("Bob-content", {
        timeout: SYNC_TIMEOUT,
      });

      await expect(bob.locator(".tiptap")).toContainText("Alice-content", {
        timeout: SYNC_TIMEOUT,
      });
      await expect(bob.locator(".tiptap")).toContainText("Bob-content", {
        timeout: SYNC_TIMEOUT,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("user count updates for connected peers", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      await createDocViaRelay(alice, baseURL, relay.multiaddr);

      // Alice alone — "Just you" or still settling.
      const aliceUsers = alice.locator("[data-testid='cs-users-count']");
      await expect(aliceUsers).toContainText(
        /Just you|Looking for peers|Connecting/,
        { timeout: 5_000 },
      );

      // Bob joins.
      const writeUrl = await getWriteUrl(alice);
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Both should show "2 users editing" via awareness.
      await expect(aliceUsers).toContainText("2 users editing", {
        timeout: SYNC_TIMEOUT,
      });

      const bobUsers = bob.locator("[data-testid='cs-users-count']");
      await expect(bobUsers).toContainText("2 users editing", {
        timeout: SYNC_TIMEOUT,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("three peers converge", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctxA = await browser.newContext();
    const alice = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const bob = await ctxB.newPage();
    const ctxC = await browser.newContext();
    const carol = await ctxC.newPage();

    try {
      await createDocViaRelay(alice, baseURL, relay.multiaddr);
      const writeUrl = await getWriteUrl(alice);

      await openDocViaRelay(bob, writeUrl, relay.multiaddr);
      await openDocViaRelay(carol, writeUrl, relay.multiaddr);

      // Wait for all peers to see each other
      // (3 total including self).
      for (const p of [alice, bob, carol]) {
        await expect(p.locator("[data-testid='cs-users-count']")).toContainText(
          "3 users editing",
          {
            timeout: SYNC_TIMEOUT,
          },
        );
      }

      // Verify actual doc sync is operational — not
      // just awareness. WebRTC data channels may lag
      // behind GossipSub awareness discovery.
      await waitForDocSync(alice, bob, "SYNC_AB");
      await waitForDocSync(alice, carol, "SYNC_AC");

      // Each peer types unique content.
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("FromAlice");

      await bob.locator(".tiptap").click();
      await bob.keyboard.type("FromBob");

      await carol.locator(".tiptap").click();
      await carol.keyboard.type("FromCarol");

      // All three should converge — each sees all
      // three strings.
      for (const page of [alice, bob, carol]) {
        await expect(page.locator(".tiptap")).toContainText("FromAlice", {
          timeout: SYNC_TIMEOUT,
        });
        await expect(page.locator(".tiptap")).toContainText("FromBob", {
          timeout: SYNC_TIMEOUT,
        });
        await expect(page.locator(".tiptap")).toContainText("FromCarol", {
          timeout: SYNC_TIMEOUT,
        });
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
      await ctxC.close();
    }
  });

  test("late joiner sees existing content", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();

    try {
      await createDocViaRelay(alice, baseURL, relay.multiaddr);

      // Alice types content before Bob exists.
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("Content before Bob joined");

      // Publish so content persists for late joiners.
      const save = alice.locator(".poka-save-indicator");
      await expect(save).toHaveClass(/poka-save-indicator--action/, {
        timeout: 5_000,
      });
      await save.click();
      // Wait for save to complete — indicator should
      // no longer show a save-action label. Relay-
      // connected publish can be slow.
      await expect(save).not.toHaveClass(/poka-save-indicator--action/, {
        timeout: PUBLISH_TIMEOUT,
      });

      const writeUrl = await getWriteUrl(alice);

      // Bob joins after Alice has published.
      const bobCtx = await browser.newContext();
      const bob = await bobCtx.newPage();

      try {
        await openDocViaRelay(bob, writeUrl, relay.multiaddr);

        // Wait for peer connection so reconciliation
        // can deliver the published content.
        await expect(
          bob.locator("[data-testid='cs-users-count']"),
        ).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });

        // Bob should see Alice's previously published
        // content.
        await expect(bob.locator(".tiptap")).toContainText(
          "Content before Bob joined",
          {
            timeout: SYNC_TIMEOUT,
          },
        );
      } finally {
        await bobCtx.close();
      }
    } finally {
      await aliceCtx.close();
    }
  });
});
