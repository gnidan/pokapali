/**
 * Lazy-init smoke E2E — verifies #200 behavior.
 *
 * After lazy Helia init, the editor should appear
 * immediately and be editable without waiting for
 * IPFS bootstrap. These tests run without any relay
 * or network — pure local-only operation.
 */

import { test, expect } from "@playwright/test";

/**
 * Editor mount timeout — should be fast now that
 * Helia defers. Pre-#200 this was 8-15s; post-#200
 * the editor should mount in <2s.
 */
const FAST_MOUNT_TIMEOUT = 3_000;

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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await clearIDB(page);
});

test.describe("lazy init smoke", () => {
  test("editor mounts quickly without network", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();

    // Editor should appear fast — Helia defers.
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: FAST_MOUNT_TIMEOUT,
    });
  });

  test("content is editable before P2P connects", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();

    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: FAST_MOUNT_TIMEOUT,
    });

    // Type immediately — should work with local-only
    // state before Helia finishes bootstrapping.
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Lazy init works");

    // Content should be in the editor.
    await expect(editor).toContainText("Lazy init works");
  });

  test("connection status bar renders", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();

    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: FAST_MOUNT_TIMEOUT,
    });

    // Status bar should appear (even in connecting
    // state — lazy init means it starts disconnected).
    const status = page.locator(".connection-status");
    await expect(status).toBeVisible({ timeout: 5_000 });

    // Users count should show at least 1 (self).
    const users = page.locator("[data-testid='cs-users-count']");
    await expect(users).toContainText("1");
  });

  test("admin badge shows without waiting for P2P", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();

    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: FAST_MOUNT_TIMEOUT,
    });

    // Badge is derived from capability, not P2P state.
    const badge = page.locator(".badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Admin");
  });
});
