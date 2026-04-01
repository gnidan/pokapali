/**
 * Block requests drawer E2E tests — single-browser.
 *
 * Tests the click-triggered drawer that shows
 * outstanding block requests in the sync summary.
 * Publishing creates version entries that populate
 * the drawer.
 *
 * #346
 */

import { test, expect } from "./e2e-fixtures.js";

const EDITOR_TIMEOUT = 8_000;
const PUBLISH_TIMEOUT = 10_000;

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

async function createDoc(page: import("@playwright/test").Page) {
  await page.goto("/");
  await clearIDB(page);
  await page.goto("/");
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

test.describe("block requests drawer", () => {
  test("sync summary appears after publish", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Drawer test content");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });
  });

  test("click opens drawer", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Open drawer test");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    await summary.click();

    const drawer = page.locator("[data-testid='cs-block-drawer']");
    await expect(drawer).toBeVisible({
      timeout: 2_000,
    });
  });

  test("drawer shows header and block entries", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Content for entries");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });
    await summary.click();

    const drawer = page.locator("[data-testid='cs-block-drawer']");
    await expect(drawer).toBeVisible({
      timeout: 2_000,
    });

    // Header should be present.
    await expect(drawer.locator(".cs-block-drawer-header")).toContainText(
      "Block requests",
    );

    // At least one block row should exist.
    await expect(drawer.locator(".cs-block-row")).toHaveCount(1, {
      timeout: 5_000,
    });
  });

  test("click toggles drawer closed", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Toggle test");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // Open.
    await summary.click();
    const drawer = page.locator("[data-testid='cs-block-drawer']");
    await expect(drawer).toBeVisible({
      timeout: 2_000,
    });

    // Close by clicking summary again.
    await summary.click();
    await expect(drawer).not.toBeVisible({
      timeout: 2_000,
    });
  });

  test("click outside closes drawer", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Click-away test");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // Open.
    await summary.click();
    const drawer = page.locator("[data-testid='cs-block-drawer']");
    await expect(drawer).toBeVisible({
      timeout: 2_000,
    });

    // Click on the editor (outside the drawer).
    await page.locator(".tiptap").click();
    await expect(drawer).not.toBeVisible({
      timeout: 2_000,
    });
  });

  test("drawer does not open on hover", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Hover test");

    const summary = page.locator("[data-testid='cs-sync-summary']");
    await expect(summary).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // Hover over the summary without clicking.
    await summary.hover();

    const drawer = page.locator("[data-testid='cs-block-drawer']");
    // Brief wait to confirm drawer does NOT appear.
    await page.waitForTimeout(500);
    await expect(drawer).toHaveCount(0);
  });
});
