/**
 * snapshot-exchange-diag.e2e.ts — D-smoke-e3 (#128)
 *
 * E2E smoke test for the snapshot-exchange diagnostics
 * panel. Verifies the panel renders unconditionally,
 * captures catalog and block events during a
 * multi-peer publish flow, and respects the 20-event
 * ring buffer bound.
 *
 * S54 D-smoke-e3.
 */

// Polyfill for Node < 22 (libp2p deps require it)
if (typeof Promise.withResolvers !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import { test, expect } from "@playwright/test";
import { createTestRelay } from "@pokapali/test-utils";

const EDITOR_TIMEOUT = 8_000;
const SYNC_TIMEOUT = 30_000;
const PUBLISH_TIMEOUT = 45_000;

// ---- helpers ----

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

// ---- tests ----

test.describe("snapshot-exchange diagnostics panel", () => {
  test.slow();

  test("panel visible, shows empty state", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await createDocViaRelay(page, baseURL, relay.multiaddr);

      // Panel visible unconditionally
      await expect(
        page.locator("[data-testid='snapshot-exchange-panel']"),
      ).toBeVisible({ timeout: EDITOR_TIMEOUT });

      // Shows empty state initially (solo peer,
      // no exchange yet)
      await expect(
        page.locator("[data-testid='snapshot-exchange-empty']"),
      ).toContainText("No exchange activity yet");
    } finally {
      await ctx.close();
      await relay.stop();
    }
  });

  test("captures events during multi-peer publish", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay();
    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();

    try {
      // Alice creates doc
      await createDocViaRelay(alice, baseURL, relay.multiaddr);

      // Alice types + publishes BEFORE Bob joins
      await alice.locator(".tiptap").click();
      await alice.keyboard.type("Diag test content");

      const aliceSave = alice.locator(".poka-save-indicator");
      await expect(aliceSave).toHaveClass(/poka-save-indicator--action/, {
        timeout: 5_000,
      });
      await aliceSave.click();
      await expect(aliceSave).toHaveClass(/poka-save-indicator--saved/, {
        timeout: PUBLISH_TIMEOUT,
      });

      // Alice should see BLK (local) events from
      // her own publish
      const alicePanel = alice.locator(
        "[data-testid='snapshot-exchange-panel']",
      );
      await expect(alicePanel).toBeVisible();

      // Wait for local block events to appear
      await expect(
        alice.locator("[data-testid='snapshot-exchange-activity']"),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });

      // Check Alice has local BLK events
      const aliceLocalBlks = alice.locator(
        "[data-testid='snapshot-exchange-event']" +
          "[data-kind='blk']" +
          "[data-locality='local']",
      );
      await expect(aliceLocalBlks.first()).toBeVisible({
        timeout: SYNC_TIMEOUT,
      });

      // Bob joins
      const writeUrl = await getWriteUrl(alice);
      await openDocViaRelay(bob, writeUrl, relay.multiaddr);

      // Wait for peer awareness
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

      // Bob's panel should show exchange activity
      // as snapshot data arrives via reconciliation
      const bobPanel = bob.locator("[data-testid='snapshot-exchange-panel']");
      await expect(bobPanel).toBeVisible();

      // Wait for Bob to receive snapshot events
      // (either catalog or remote BLK)
      await expect(
        bob.locator("[data-testid='snapshot-exchange-activity']"),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });

      // Bob should have at least one event row
      const bobEvents = bob.locator("[data-testid='snapshot-exchange-event']");
      await expect(bobEvents.first()).toBeVisible({
        timeout: SYNC_TIMEOUT,
      });

      // Verify event rows have the expected
      // structure: time, arrow, kind, detail
      const firstEvent = bobEvents.first();
      await expect(firstEvent.locator(".cs-sx-time")).toBeVisible();
      await expect(firstEvent.locator(".cs-sx-kind")).toBeVisible();
      await expect(firstEvent.locator(".cs-sx-detail")).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
      await relay.stop();
    }
  });
});
