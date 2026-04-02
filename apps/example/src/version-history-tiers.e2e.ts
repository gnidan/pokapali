/**
 * Version history tier badge & expiry E2E tests.
 *
 * Tests that pinner-provided retention tier badges
 * and expiry countdowns render in the version list.
 * Uses page.route() to intercept HTTP requests to
 * the mock pinner URL advertised by the test relay.
 *
 * #264
 */

import { test, expect } from "./e2e-fixtures.js";
import { readFile } from "node:fs/promises";

const RELAY_INFO_PATH =
  process.env.RELAY_INFO_PATH || "/tmp/pokapali-test-relay.json";
const EDITOR_TIMEOUT = 8_000;
// Relay-connected tests need longer for IPFS
// snapshot creation + network overhead.
const PUBLISH_TIMEOUT = 30_000;

/** How long to wait for relay connection to
 *  establish and caps to propagate. */
const RELAY_CONNECT_TIMEOUT = 30_000;

/** How long to wait for the tier data to arrive
 *  after the drawer is opened. The relay must
 *  connect, caps must propagate, node-change must
 *  fire, and the hook must re-fetch. GossipSub
 *  caps can occasionally take 30s+ to arrive —
 *  use generous timeout. */
const TIER_TIMEOUT = 45_000;

interface RelayInfo {
  multiaddr: string;
  peerId: string;
  httpUrl: string;
}

async function loadRelayInfo(): Promise<RelayInfo> {
  // Retry a few times — the relay file may be
  // briefly unavailable if a prior test's cleanup
  // races with global setup on the CI runner.
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

async function typeAndPublish(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(text);

  const save = page.locator(".poka-save-indicator");
  // Wait for actionable state (dirty or unpublished)
  // — NOT /Save/ which also matches "Saved".
  await expect(save).toHaveClass(/poka-save-indicator--action/, {
    timeout: 5_000,
  });
  await save.click();
  await expect(save).not.toHaveClass(/poka-save-indicator--action/, {
    timeout: PUBLISH_TIMEOUT,
  });
}

async function replaceAndPublish(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);

  const save = page.locator(".poka-save-indicator");
  await expect(save).toHaveClass(/poka-save-indicator--action/, {
    timeout: 5_000,
  });
  await save.click();
  await expect(save).not.toHaveClass(/poka-save-indicator--action/, {
    timeout: PUBLISH_TIMEOUT,
  });
}

// Two pre-computed valid CID strings for mock
// pinner responses (raw codec + sha256).
const MOCK_CID_1 =
  "bafkreiavfjjt4ofifyuupfdlqu6dc45ha3zaj365aqurwce7ppqk5bjsga";
const MOCK_CID_2 =
  "bafkreihavvwxymi2lq2n5uhuyirte2fspttsoesuc3uneovznrvgkerljm";

/**
 * Wait for the test relay to be connected. The
 * node-status dot transitions from "disconnected"
 * to "partial" (1 node) once caps are received.
 * This ensures the app has discovered the relay's
 * httpUrl before we check for tier badges.
 */
async function waitForRelayConnection(page: import("@playwright/test").Page) {
  await expect(
    page.locator("[data-testid='cs-node-status'] .cs-dot"),
  ).not.toHaveClass(/disconnected/, {
    timeout: RELAY_CONNECT_TIMEOUT,
  });
}

/**
 * Set up page.route() to intercept pinner history
 * requests and return mock entries with tier data.
 */
async function mockPinnerHistory(
  page: import("@playwright/test").Page,
  httpUrl: string,
  entries: Array<{
    cid: string;
    seq: number;
    ts: number;
    tier: string;
    expiresAt: number | null;
  }>,
) {
  await page.route(`${httpUrl}/**`, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ versions: entries }),
    });
  });
}

test.describe("version history tier badges", () => {
  test.slow();

  test("tier badges render for pinner-enriched entries", async ({
    browser,
  }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Mock pinner returns entries with tier data.
      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 2,
          ts: now - 60_000,
          tier: "full",
          expiresAt: null,
        },
        {
          cid: MOCK_CID_2,
          seq: 1,
          ts: now - 120_000,
          tier: "hourly",
          expiresAt: now + 3_600_000 * 12,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);

      // Wait for relay to connect so the app
      // discovers the pinner httpUrl for tier data.
      await waitForRelayConnection(page);

      // Publish a version so the drawer has content
      // and the hook has a reason to fetch.
      await typeAndPublish(page, "Tier badge test");

      // Open the version history drawer.
      await page.locator(".toggle-history").click();

      // Wait for tier badges to appear. The hook
      // re-fetches from the pinner after the relay's
      // caps arrive via GossipSub.
      const fullBadge = page.locator(".vh-tier-full");
      await expect(fullBadge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });

      const hourlyBadge = page.locator(".vh-tier-hourly");
      await expect(hourlyBadge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
    } finally {
      await ctx.close();
    }
  });

  test("tier badge shows correct tier text", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "daily",
          expiresAt: now + 3_600_000 * 48,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await typeAndPublish(page, "Daily tier test");

      await page.locator(".toggle-history").click();

      const dailyBadge = page.locator(".vh-tier-daily");
      await expect(dailyBadge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
      await expect(dailyBadge).toContainText("daily");
    } finally {
      await ctx.close();
    }
  });

  test("expiry countdown renders in tier badge", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Set expiry 12 hours from now → "~12 hours left"
      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "hourly",
          expiresAt: now + 3_600_000 * 12,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await typeAndPublish(page, "Expiry countdown");

      await page.locator(".toggle-history").click();

      const badge = page.locator(".vh-tier-hourly");
      await expect(badge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });

      // relativeExpiry(now + 12h) → "~12 hours left"
      await expect(badge).toContainText("hours left", {
        timeout: 5_000,
      });
    } finally {
      await ctx.close();
    }
  });

  test("expiry shows days for distant expiry", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Set expiry 3 days from now → "~3 days left"
      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "daily",
          expiresAt: now + 3_600_000 * 24 * 3,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await typeAndPublish(page, "Days expiry test");

      await page.locator(".toggle-history").click();

      const badge = page.locator(".vh-tier-daily");
      await expect(badge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
      await expect(badge).toContainText("days left", {
        timeout: 5_000,
      });
    } finally {
      await ctx.close();
    }
  });

  test("tip tier does not show badge", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Tip tier should NOT render a badge.
      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "tip",
          expiresAt: null,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await typeAndPublish(page, "Tip tier test");

      await page.locator(".toggle-history").click();

      // Wait for the version entry to appear.
      await expect(page.locator("[data-testid='vh-entry']")).toBeVisible({
        timeout: PUBLISH_TIMEOUT,
      });

      // Give time for any potential tier badge
      // rendering, then verify none exist.
      await page.waitForTimeout(2_000);
      await expect(page.locator(".vh-item-retention")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("expires soon shows for near-expiry entries", async ({ browser }) => {
    const relay = await loadRelayInfo();
    const baseURL = test.info().project.use.baseURL!;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Expiry 30 min from now → "expires soon"
      // (less than 1 hour)
      await mockPinnerHistory(page, relay.httpUrl, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "hourly",
          expiresAt: now + 1_800_000,
        },
      ]);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await typeAndPublish(page, "Expires soon test");

      await page.locator(".toggle-history").click();

      const badge = page.locator(".vh-tier-hourly");
      await expect(badge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
      await expect(badge).toContainText("expires soon", { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});
