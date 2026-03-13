/**
 * Comments UI E2E tests — single-browser.
 *
 * Tests the comment popover, sidebar, threading,
 * and resolve flows using data-testid selectors.
 */

import { test, expect } from "@playwright/test";

const EDITOR_TIMEOUT = 8_000;

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
 * Navigate to landing, clear IDB, create a new doc,
 * and wait for the editor to mount.
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
 * Type text into the editor, then select it by
 * triple-clicking (selects the paragraph).
 */
async function typeAndSelect(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(text);

  // Triple-click to select the paragraph.
  await editor.click({ clickCount: 3 });
}

test.describe("comments UI", () => {
  test("select text shows comment popover", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Selectable text");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("[data-testid='add-comment-btn']")).toBeVisible();
  });

  test("click add-comment opens sidebar with input", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Comment target");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });

    await page.locator("[data-testid='add-comment-btn']").click();

    // Sidebar should open.
    const sidebar = page.locator("[data-testid='comment-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    // Comment input should be present.
    const input = page.locator("[data-testid='comment-input']");
    await expect(input).toBeVisible();
  });

  test("submit comment creates comment item", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Text to comment on");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    // Type a comment and submit.
    const input = page.locator("[data-testid='comment-input']");
    await input.fill("This is my comment");
    await page.locator("[data-testid='comment-submit']").click();

    // Comment item should appear in the sidebar.
    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible({ timeout: 3_000 });
    await expect(item).toContainText("This is my comment");
  });

  test("reply to comment shows thread", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Threaded discussion");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    // Submit the root comment.
    const input = page.locator("[data-testid='comment-input']");
    await input.fill("Root comment");
    await page.locator("[data-testid='comment-submit']").click();

    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible({ timeout: 3_000 });

    // Click reply on the root comment.
    await page.locator("[data-testid='reply-btn']").first().click();

    // Reply input should appear. It reuses the same
    // comment-input testid inside the reply wrap.
    const replyInput = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-input']");
    await expect(replyInput).toBeVisible();
    await replyInput.fill("A reply");

    const replySubmit = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-submit']");
    await replySubmit.click();

    // Thread should now have 2 comment items
    // (root + reply).
    const items = page.locator("[data-testid='comment-item']");
    await expect(items).toHaveCount(2, { timeout: 3_000 });

    // The reply should have the .cs-reply class.
    const reply = page.locator("[data-testid='comment-item'].cs-reply");
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("A reply");
  });

  test("resolve comment updates visual state", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Resolvable comment");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    // Submit a comment.
    const input = page.locator("[data-testid='comment-input']");
    await input.fill("To be resolved");
    await page.locator("[data-testid='comment-submit']").click();

    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible({ timeout: 3_000 });

    // Click resolve.
    await page.locator("[data-testid='resolve-btn']").click();

    // The comment should move to "resolved" section.
    // Open comments list should be empty; resolved
    // toggle should appear.
    const resolvedToggle = page.locator(".cs-resolved-toggle");
    await expect(resolvedToggle).toBeVisible({
      timeout: 3_000,
    });
    await expect(resolvedToggle).toContainText("1 resolved");

    // Click to show resolved comments.
    await resolvedToggle.click();

    // The resolved comment should have the class.
    const resolved = page.locator("[data-testid='comment-item'].cs-resolved");
    await expect(resolved).toBeVisible();
    await expect(resolved).toContainText("To be resolved");
  });
});
