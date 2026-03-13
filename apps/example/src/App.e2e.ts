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
