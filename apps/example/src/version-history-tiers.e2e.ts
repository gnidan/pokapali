/**
 * Version history tier badge & expiry E2E tests.
 *
 * Tests that pinner-provided retention tier badges
 * and expiry countdowns render in the version list.
 * Uses page.route() to intercept HTTP requests to
 * a mock pinner URL advertised by a per-test relay.
 *
 * Per-test relays with fast caps publishing (2s)
 * eliminate GossipSub timing flakes that occur
 * with the shared global relay (#133).
 *
 * #264
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

const MOCK_PINNER_URL = "http://mock-pinner.test";

const EDITOR_TIMEOUT = 8_000;
// Relay-connected tests need longer for IPFS
// snapshot creation + network overhead.
const PUBLISH_TIMEOUT = 30_000;

/** How long to wait for relay connection to
 *  establish and caps to propagate. Per-test
 *  relays publish caps every 2s, so this is
 *  generous. */
const RELAY_CONNECT_TIMEOUT = 30_000;

/** How long to wait for the tier data to arrive
 *  after the drawer is opened. The relay must
 *  connect, caps must propagate, node-change must
 *  fire, and the hook must re-fetch. With 2s caps
 *  interval this should be fast, but allow headroom
 *  for CI. */
const TIER_TIMEOUT = 45_000;

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
 * Wait for the mock pinner to be queried. The app
 * fetches from the pinner httpUrl once caps arrive
 * and the useVersionHistory hook's onNodeChange
 * triggers a re-fetch. This is the reliable sync
 * point: once the response is fulfilled, tier data
 * is guaranteed to be in React state.
 *
 * Returns a promise that resolves when the response
 * is received. Must be called BEFORE navigations so
 * it captures the request whenever it happens.
 */
function waitForPinnerQuery(
  page: import("@playwright/test").Page,
  httpUrl: string,
): Promise<import("@playwright/test").Response> {
  return page.waitForResponse((resp) => resp.url().startsWith(httpUrl), {
    timeout: TIER_TIMEOUT,
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
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Mock pinner returns entries with tier data.
      await mockPinnerHistory(page, MOCK_PINNER_URL, [
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

      // Start listening for the mock pinner query
      // BEFORE navigation so we capture it whenever
      // the hook's doFetch fires.
      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);

      // Wait for the mock pinner to be queried —
      // confirms caps propagated and tier data is
      // in React state.
      await pinnerResp;

      // Publish a version so the drawer has content.
      await typeAndPublish(page, "Tier badge test");

      // Open the version history drawer.
      await page.locator(".toggle-history").click();

      // Tier data is already in state (confirmed
      // by pinnerResp above), so badges should
      // render quickly after the drawer opens.
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
      await relay.stop();
    }
  });

  test("tier badge shows correct tier text", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      await mockPinnerHistory(page, MOCK_PINNER_URL, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "daily",
          expiresAt: now + 3_600_000 * 48,
        },
      ]);

      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await pinnerResp;

      await typeAndPublish(page, "Daily tier test");

      await page.locator(".toggle-history").click();

      const dailyBadge = page.locator(".vh-tier-daily");
      await expect(dailyBadge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
      await expect(dailyBadge).toContainText("daily");
    } finally {
      await ctx.close();
      await relay.stop();
    }
  });

  test("expiry countdown renders in tier badge", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Set expiry 12 hours from now →
      // "~12 hours left"
      await mockPinnerHistory(page, MOCK_PINNER_URL, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "hourly",
          expiresAt: now + 3_600_000 * 12,
        },
      ]);

      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await pinnerResp;

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
      await relay.stop();
    }
  });

  test("expiry shows days for distant expiry", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Set expiry 3 days from now → "~3 days left"
      await mockPinnerHistory(page, MOCK_PINNER_URL, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "daily",
          expiresAt: now + 3_600_000 * 24 * 3,
        },
      ]);

      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await pinnerResp;

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
      await relay.stop();
    }
  });

  test("tip tier does not show badge", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Tip tier should NOT render a badge.
      await mockPinnerHistory(page, MOCK_PINNER_URL, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "tip",
          expiresAt: null,
        },
      ]);

      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await pinnerResp;

      await typeAndPublish(page, "Tip tier test");

      await page.locator(".toggle-history").click();

      // Wait for at least one version entry to
      // appear. Use .first() because the mock entry
      // and the real published version both render
      // as vh-entry elements (strict mode requires
      // a single match).
      await expect(
        page.locator("[data-testid='vh-entry']").first(),
      ).toBeVisible({
        timeout: PUBLISH_TIMEOUT,
      });

      // Give time for any potential tier badge
      // rendering, then verify none exist.
      await page.waitForTimeout(2_000);
      await expect(page.locator(".vh-item-retention")).toHaveCount(0);
    } finally {
      await ctx.close();
      await relay.stop();
    }
  });

  test("expires soon shows for near-expiry entries", async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
      capsIntervalMs: 2_000,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const now = Date.now();

      // Expiry 30 min from now → "expires soon"
      // (less than 1 hour)
      await mockPinnerHistory(page, MOCK_PINNER_URL, [
        {
          cid: MOCK_CID_1,
          seq: 1,
          ts: now - 60_000,
          tier: "hourly",
          expiresAt: now + 1_800_000,
        },
      ]);

      const pinnerResp = waitForPinnerQuery(page, MOCK_PINNER_URL);

      await createDocViaRelay(page, baseURL, relay.multiaddr);
      await waitForRelayConnection(page);
      await pinnerResp;

      await typeAndPublish(page, "Expires soon test");

      await page.locator(".toggle-history").click();

      const badge = page.locator(".vh-tier-hourly");
      await expect(badge).toBeVisible({
        timeout: TIER_TIMEOUT,
      });
      await expect(badge).toContainText("expires soon", { timeout: 5_000 });
    } finally {
      await ctx.close();
      await relay.stop();
    }
  });
});
