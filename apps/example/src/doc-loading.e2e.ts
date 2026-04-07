/**
 * Document loading state E2E tests — single-browser.
 *
 * Tests loading indicators, ready states, and
 * navigation between landing and editor.
 */

import { test, expect } from "./e2e-fixtures.js";

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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await clearIDB(page);
});

test.describe("document loading", () => {
  test("landing page renders before any doc", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".landing")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Create new document",
      }),
    ).toBeVisible();

    // Editor should NOT be visible on landing.
    await expect(page.locator(".tiptap")).not.toBeVisible();
  });

  test("create doc transitions from landing to editor", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();

    // Editor should appear.
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Landing should be gone.
    await expect(page.locator(".landing")).not.toBeVisible();

    // URL should have changed to a doc URL.
    expect(page.url()).toContain("/doc/");
  });

  test("back arrow returns to landing", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    await page.locator(".back-arrow").click();

    await expect(page.locator(".landing")).toBeVisible();
    await expect(page.locator(".tiptap")).not.toBeVisible();
  });

  test("direct doc URL opens editor", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const docUrl = page.url();

    // Navigate away and back to the doc URL.
    await page.goto("/");
    await expect(page.locator(".landing")).toBeVisible();

    await page.goto(docUrl);
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
  });

  test("editor shows role badge", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Creator gets admin role.
    const badge = page.locator(".badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Admin");
  });

  test("read-only URL shows read-only banner", async ({ page, context }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Type some content.
    await page.locator(".tiptap").click();
    await page.keyboard.type("Read-only check");

    // Get the read-only URL from share panel.
    await page.locator("[data-testid='share-toggle']").click();
    await expect(page.locator("[data-testid='share-panel']")).toBeVisible();

    const readCard = page.locator(".share-card", {
      has: page.locator(".share-card-label", {
        hasText: "Read",
      }),
    });
    const readUrl = await readCard.locator("input").getAttribute("title");

    if (!readUrl) {
      test.skip(true, "Could not get read URL");
      return;
    }

    // Open read URL in new page.
    const page2 = await context.newPage();
    await page2.goto(readUrl);
    await expect(page2.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Should show read-only banner.
    const banner = page2.locator(".read-only-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Read-only");

    // Should show Reader badge.
    const badge = page2.locator(".badge");
    await expect(badge).toContainText("Reader");

    await page2.close();
  });

  test("open doc via URL input on landing", async ({ page, context }) => {
    // Create a doc first.
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
    const docUrl = page.url();

    // Open a new page and use the URL input.
    const page2 = await context.newPage();
    await page2.goto("/");

    const input = page2.getByLabel("Document capability URL");
    await input.fill(docUrl);
    await page2.locator(".open-form button").click();

    await expect(page2.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
    await page2.close();
  });

  test("connection status appears in editor", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Connection status bar should be visible.
    const status = page.locator(".connection-status");
    await expect(status).toBeVisible();

    // Peer presence should show once connected.
    const users = page.locator("[data-testid='cs-users-count']");
    await expect(users).toContainText(/Just you|Looking for peers|Connecting/);
  });

  test("save state shows on new doc", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // New doc should show "Save now".
    const save = page.locator(".poka-save-indicator");
    await expect(save).toBeVisible();
    await expect(save).toContainText("Save");
  });
});
