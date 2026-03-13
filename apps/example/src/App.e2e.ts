import { test, expect } from "@playwright/test";

/**
 * Editor mount timeout — reflects actual Helia/IPFS
 * bootstrap time. Use test.slow() for tests that
 * need more headroom.
 */
const EDITOR_TIMEOUT = 8_000;

/**
 * Clear all IndexedDB databases so each test starts
 * with clean storage. Playwright creates a fresh
 * BrowserContext per test, but IDB can persist across
 * contexts in the same browser instance.
 */
async function clearIndexedDB(page: import("@playwright/test").Page) {
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
  await clearIndexedDB(page);
});

test.describe("smoke tests", () => {
  test("app loads without crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.locator(".landing")).toBeVisible();
    await expect(page.locator("h1", { hasText: "Pokapali" })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Create new document",
      }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("create document renders editor", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();

    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    await expect(page.locator(".back-arrow")).toBeVisible();
    await expect(page.locator(".badge")).toBeVisible();
    await expect(page.locator(".doc-title")).toBeVisible();
  });

  test("type in editor", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Hello, Playwright!");

    await expect(editor).toContainText("Hello, Playwright!");
  });

  test("content channel works without error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const channelErrors = errors.filter(
      (e) =>
        e.toLowerCase().includes("unknown channel") ||
        e.toLowerCase().includes("channel"),
    );
    expect(channelErrors).toEqual([]);
  });

  test("open document by URL from landing", async ({ page, context }) => {
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

    const page2 = await context.newPage();
    await page2.goto("/");

    const input = page2.getByLabel("Document capability URL");
    await input.fill(docUrl);
    await page2.locator(".open-form button").click();

    await expect(page2.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
    await expect(page2.locator(".back-arrow")).toBeVisible();
  });
});

test.describe("publish / save flow", () => {
  test("new doc shows Publish now button", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const save = page.locator(".save-state");
    await expect(save).toBeVisible();
    await expect(save).toContainText("Publish now");
    // It's a button when publishable.
    await expect(save).toHaveClass(/save-action/);
  });

  test("typing transitions state to dirty", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const save = page.locator(".save-state");
    await expect(save).toContainText("Publish now");

    await page.locator(".tiptap").click();
    await page.keyboard.type("Hello");

    await expect(save).toContainText("Publish changes", {
      timeout: 5_000,
    });
    await expect(save).toHaveClass(/dirty/);
  });

  test("clicking publish triggers save progression", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Type to get into dirty state.
    await page.locator(".tiptap").click();
    await page.keyboard.type("Content to publish");

    const save = page.locator(".save-state");
    await expect(save).toContainText("Publish changes", {
      timeout: 5_000,
    });

    // Click publish — should transition through saving.
    await save.click();

    // Accept any post-click state: "Saving...",
    // "Published", or "Save failed" (no pinners in
    // test env). The key assertion is that click
    // triggers a state change from "Publish changes".
    await expect(save).not.toContainText("Publish changes", {
      timeout: 5_000,
    });
  });
});

test.describe("connection status", () => {
  test("users count is visible", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const users = page.locator("[data-testid='cs-users-count']");
    await expect(users).toBeVisible();
    // Single user editing alone.
    await expect(users).toContainText("1");
  });

  test("node and network status dots display", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    await expect(page.locator("[data-testid='cs-node-status']")).toBeVisible();
    await expect(
      page.locator("[data-testid='cs-network-status']"),
    ).toBeVisible();
  });

  test("no connected pinners warning in isolated env", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // In test environment with no relays/pinners,
    // either "No connected pinners" or
    // "Checking for pinners" should appear.
    const status = page.locator(".connection-status");
    await expect(status).toBeVisible();

    // Wait for the node capability check to settle.
    const noPinner = page.locator(".cs-no-pinner");
    const checking = page.locator(".cs-checking-pinners");

    // One of these should be visible within a
    // reasonable time — no pinners in test env.
    await expect(noPinner.or(checking)).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("error states", () => {
  test("invalid URL shows error on landing", async ({ page }) => {
    await page.goto("/");

    const input = page.getByLabel("Document capability URL");
    await input.fill("not-a-valid-url");
    await page.locator(".open-form button").click();

    // Error should appear.
    const error = page.locator(".landing-error");
    await expect(error).toBeVisible({ timeout: 5_000 });
  });

  test("malformed hash in URL shows error", async ({ page }) => {
    // Navigate directly to a URL with garbage hash.
    await page.goto("/#/doc/ZZZZ_invalid_capability");

    // App should show error or remain on landing.
    // The auto-open logic will try app.open() which
    // will fail on the malformed capability.
    const error = page.locator(".landing-error");
    const landing = page.locator(".landing");

    // Either an error appears or we stay on landing.
    await expect(error.or(landing)).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
  });

  test("back arrow navigates to landing", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create new document" }).click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Click back arrow.
    await page.locator(".back-arrow").click();

    // Should return to landing.
    await expect(page.locator(".landing")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create new document" }),
    ).toBeVisible();
  });
});

test.describe("edge cases", () => {
  test("open document by direct URL navigation", async ({ page }) => {
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

    await page.goto(docUrl);
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });
    await expect(page.locator(".back-arrow")).toBeVisible();
  });

  test("version history panel opens", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    await page.locator(".toggle-history").click();
    await expect(page.locator(".vh-drawer")).toBeVisible();

    await expect(page.locator(".vh-empty")).toContainText(
      "No versions published yet",
    );
  });

  test("save status shows unpublished for new doc", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const saveEl = page.locator(".save-state");
    await expect(saveEl).toBeVisible();
    await expect(saveEl).toContainText(/Publish/);

    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Some content");
    await expect(saveEl).toContainText("Publish changes", { timeout: 5_000 });
  });
});
