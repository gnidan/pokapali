/**
 * Version history E2E tests — single-browser.
 *
 * Tests the publish → version list → preview →
 * restore flow. Publishing creates a local snapshot
 * even without pinners, which populates the drawer
 * via the "snapshot" event.
 */

import { test, expect } from "@playwright/test";

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

/**
 * Navigate, clear IDB, create doc, wait for editor.
 */
async function createDoc(page: import("@playwright/test").Page) {
  await page.goto("/");
  await clearIDB(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Create new document" }).click();
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

/**
 * Type content, click publish, wait for state to
 * leave "Publish changes" (accepted by the app).
 */
async function typeAndPublish(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(text);

  const save = page.locator(".save-state");
  await expect(save).toContainText(/Publish/, {
    timeout: 5_000,
  });

  await save.click();

  // Wait for state to transition away from the
  // publish button text — "Saving...", "Published",
  // or "Save failed" all count as progress.
  await expect(save).not.toContainText(/Publish/, { timeout: PUBLISH_TIMEOUT });
}

test.describe("version history", () => {
  test("publish creates version entry in drawer", async ({ page }) => {
    await createDoc(page);

    // Open history first — should be empty.
    await page.locator(".toggle-history").click();
    await expect(page.locator(".vh-drawer")).toBeVisible();
    await expect(page.locator(".vh-empty")).toContainText(
      "No versions published yet",
    );

    // Close drawer, type + publish.
    await page.locator(".toggle-history").click();
    await typeAndPublish(page, "First version content");

    // Re-open history — entry should appear.
    await page.locator(".toggle-history").click();
    const entry = page.locator("[data-testid='vh-entry']");
    await expect(entry).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // Should show seq #1 and a relative timestamp.
    await expect(entry).toContainText("#1");
  });

  test("multiple publishes create multiple entries", async ({ page }) => {
    await createDoc(page);

    // First publish.
    await typeAndPublish(page, "Version one");

    // Second edit + publish. Need to wait for state
    // to settle back to a publishable state first.
    const save = page.locator(".save-state");
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type(" plus more");
    await expect(save).toContainText(/Publish/, {
      timeout: 5_000,
    });
    await save.click();
    await expect(save).not.toContainText(/Publish/, {
      timeout: PUBLISH_TIMEOUT,
    });

    // Open drawer — should have 2 entries.
    await page.locator(".toggle-history").click();
    const entries = page.locator("[data-testid='vh-entry']");
    await expect(entries).toHaveCount(2, {
      timeout: PUBLISH_TIMEOUT,
    });
  });

  test("clicking entry shows preview overlay", async ({ page }) => {
    await createDoc(page);

    // Publish so there's a version to preview.
    await typeAndPublish(page, "Preview this content");

    // Open drawer and click the entry.
    await page.locator(".toggle-history").click();
    const entry = page.locator("[data-testid='vh-entry']");
    await expect(entry).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });
    await entry.click();

    // Preview overlay should appear.
    const overlay = page.locator(".version-preview-overlay");
    await expect(overlay).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // The preview editor should contain the published
    // content.
    const previewEditor = overlay.locator(".vpo-editor");
    await expect(previewEditor).toContainText("Preview this content", {
      timeout: 5_000,
    });
  });

  test("restore reverts editor to old version", async ({ page }) => {
    await createDoc(page);

    // Publish v1.
    await typeAndPublish(page, "Original content");

    // Edit to create v2.
    const editor = page.locator(".tiptap");
    await editor.click();
    // Select all and replace.
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("Replaced content");

    const save = page.locator(".save-state");
    await expect(save).toContainText(/Publish/, {
      timeout: 5_000,
    });
    await save.click();
    await expect(save).not.toContainText(/Publish/, {
      timeout: PUBLISH_TIMEOUT,
    });

    // Verify current editor shows new content.
    await expect(editor).toContainText("Replaced content");

    // Open drawer, click v1 (older = last in list).
    await page.locator(".toggle-history").click();
    const entries = page.locator("[data-testid='vh-entry']");
    await expect(entries).toHaveCount(2, {
      timeout: PUBLISH_TIMEOUT,
    });

    // v1 is the second entry (list is newest-first).
    await entries.last().click();

    // Preview overlay should show.
    const overlay = page.locator(".version-preview-overlay");
    await expect(overlay).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // Click restore button.
    const restoreBtn = page.locator("[data-testid='vh-restore']");
    await expect(restoreBtn).toBeVisible({
      timeout: 5_000,
    });
    await restoreBtn.click();

    // Confirm dialog should appear.
    const confirmBtn = page.locator(".vh-confirm-ok");
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Wait for overlay to close (auto-closes after
    // 1.5s on successful restore).
    await expect(overlay).not.toBeVisible({
      timeout: 5_000,
    });

    // Editor should now contain the original content.
    await expect(editor).toContainText("Original content", { timeout: 5_000 });
  });
});
