/**
 * Version history diff E2E tests — single-browser.
 *
 * Tests the diff highlighting in the preview overlay,
 * diff summary indicators in the version list, empty
 * diff for current version, and multi-version
 * navigation.
 *
 * #263
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

  const save = page.locator(".save-state");
  await expect(save).toContainText(/Publish/, {
    timeout: 5_000,
  });

  await save.click();

  await expect(save).not.toHaveClass(/save-action/, {
    timeout: PUBLISH_TIMEOUT,
  });
}

/**
 * Replace all editor content and publish.
 */
async function replaceAndPublish(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(text);

  const save = page.locator(".save-state");
  await expect(save).toContainText(/Publish/, {
    timeout: 5_000,
  });
  await save.click();
  await expect(save).not.toHaveClass(/save-action/, {
    timeout: PUBLISH_TIMEOUT,
  });
}

/**
 * Open the version history drawer, wait for entries,
 * and click the entry at the given index.
 * Returns the preview overlay locator.
 */
async function openAndPreview(
  page: import("@playwright/test").Page,
  entryIndex: number,
) {
  await page.locator(".toggle-history").click();
  const entries = page.locator("[data-testid='vh-entry']");
  await expect(entries.first()).toBeVisible({
    timeout: PUBLISH_TIMEOUT,
  });
  await entries.nth(entryIndex).click();

  const overlay = page.locator(".version-preview-overlay");
  await expect(overlay).toBeVisible({
    timeout: PUBLISH_TIMEOUT,
  });
  return overlay;
}

test.describe("version history diff", () => {
  test("preview shows diff highlighting for changed content", async ({
    page,
  }) => {
    await createDoc(page);

    // Publish v1 with known content.
    await typeAndPublish(page, "Hello world");

    // Replace content and publish v2.
    await replaceAndPublish(page, "Hello universe");

    // Open drawer and preview v1 (older = last entry).
    const overlay = await openAndPreview(page, 1);
    const previewEditor = overlay.locator(".vpo-editor");

    // v1 has "world" which is not in current ("universe")
    // → "world" should be highlighted as an addition
    // (green, .vh-diff-add) in the v1 preview.
    await expect(previewEditor.locator(".vh-diff-add")).toBeVisible({
      timeout: 5_000,
    });

    // "universe" is in current but not in v1
    // → should appear as a deletion widget
    // (red, .vh-diff-del) in the v1 preview.
    await expect(previewEditor.locator(".vh-diff-del")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("diff-add contains text from old version", async ({ page }) => {
    await createDoc(page);

    await typeAndPublish(page, "Original text");
    await replaceAndPublish(page, "Changed text");

    // Preview v1 (index 1 = older).
    const overlay = await openAndPreview(page, 1);
    const previewEditor = overlay.locator(".vpo-editor");

    // The green highlight should contain "Original"
    // (text present in v1 but not in current).
    const addSpan = previewEditor.locator(".vh-diff-add");
    await expect(addSpan).toBeVisible({ timeout: 5_000 });
    await expect(addSpan).toContainText("Original");
  });

  test("diff-del contains text from current version", async ({ page }) => {
    await createDoc(page);

    await typeAndPublish(page, "Original text");
    await replaceAndPublish(page, "Changed text");

    // Preview v1.
    const overlay = await openAndPreview(page, 1);
    const previewEditor = overlay.locator(".vpo-editor");

    // The red strikethrough should contain "Changed"
    // (text in current but missing from v1).
    const delSpan = previewEditor.locator(".vh-diff-del");
    await expect(delSpan).toBeVisible({ timeout: 5_000 });
    await expect(delSpan).toContainText("Changed");
  });

  test("current version preview shows no diff decorations", async ({
    page,
  }) => {
    await createDoc(page);

    await typeAndPublish(page, "Same content");

    // Preview v1, which IS the current version.
    const overlay = await openAndPreview(page, 0);
    const previewEditor = overlay.locator(".vpo-editor");

    // Content should match.
    await expect(previewEditor).toContainText("Same content", {
      timeout: 5_000,
    });

    // No diff decorations should be present.
    await page.waitForTimeout(500);
    await expect(previewEditor.locator(".vh-diff-add")).toHaveCount(0);
    await expect(previewEditor.locator(".vh-diff-del")).toHaveCount(0);
  });

  test("version list shows delta indicators", async ({ page }) => {
    await createDoc(page);

    // Publish v1 and v2 with different content
    // so deltas are nonzero.
    await typeAndPublish(page, "Short");
    await replaceAndPublish(page, "Much longer content");

    // Open drawer and wait for delta computation.
    await page.locator(".toggle-history").click();
    const entries = page.locator("[data-testid='vh-entry']");
    await expect(entries).toHaveCount(2, {
      timeout: PUBLISH_TIMEOUT,
    });

    // At least one entry should have a delta indicator.
    // The hook preloads version texts and computes
    // char-count deltas asynchronously.
    const delta = page.locator(".vh-item-delta");
    await expect(delta.first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("delta indicator shows positive for additions", async ({ page }) => {
    await createDoc(page);

    // v1: short, v2: longer.
    await typeAndPublish(page, "A");
    await replaceAndPublish(page, "A much longer string");

    await page.locator(".toggle-history").click();
    const entries = page.locator("[data-testid='vh-entry']");
    await expect(entries).toHaveCount(2, {
      timeout: PUBLISH_TIMEOUT,
    });

    // v2 (first entry, newest) should show a positive
    // delta relative to v1 (more chars added).
    const v2Delta = entries.first().locator(".vh-item-delta.added");
    await expect(v2Delta).toBeVisible({
      timeout: 10_000,
    });
    const text = await v2Delta.textContent();
    expect(text).toMatch(/^\+\d+$/);
  });

  test("multi-version navigation updates preview", async ({ page }) => {
    await createDoc(page);

    // Create two versions with completely distinct
    // content so assertions are unambiguous.
    await typeAndPublish(page, "Alpha first draft");
    await replaceAndPublish(page, "Beta second draft");

    // Open drawer.
    await page.locator(".toggle-history").click();
    const entries = page.locator("[data-testid='vh-entry']");
    await expect(entries).toHaveCount(2, {
      timeout: PUBLISH_TIMEOUT,
    });

    const overlay = page.locator(".version-preview-overlay");

    // Click v2 (first/newest entry).
    await entries.first().click();
    await expect(overlay).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });
    const previewEditor = overlay.locator(".vpo-editor");
    await expect(previewEditor).toContainText("Beta second draft", {
      timeout: 5_000,
    });

    // Click v1 (second/older entry) — preview updates.
    await entries.last().click();
    await expect(previewEditor).toContainText("Alpha first draft", {
      timeout: 5_000,
    });
  });

  test("version entry shows relative timestamp", async ({ page }) => {
    await createDoc(page);
    await typeAndPublish(page, "Timestamp check");

    await page.locator(".toggle-history").click();
    const entry = page.locator("[data-testid='vh-entry']");
    await expect(entry).toBeVisible({
      timeout: PUBLISH_TIMEOUT,
    });

    // The timestamp element should show a relative
    // time like "just now" or "Xs ago".
    const ts = entry.locator(".vh-item-ts");
    await expect(ts).toBeVisible();
    const text = await ts.textContent();
    expect(text).toMatch(/just now|\d+s ago/);
  });
});
