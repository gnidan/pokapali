import { test, expect } from "@playwright/test";

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

    // Editor area should appear (writer mounts
    // immediately, no loading gate)
    await expect(page.locator(".tiptap")).toBeVisible({ timeout: 15_000 });

    // Header elements present
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
    await expect(page.locator(".tiptap")).toBeVisible({ timeout: 15_000 });

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
    await expect(page.locator(".tiptap")).toBeVisible({ timeout: 15_000 });

    // No "Unknown channel" or related errors
    const channelErrors = errors.filter(
      (e) =>
        e.toLowerCase().includes("unknown channel") ||
        e.toLowerCase().includes("channel"),
    );
    expect(channelErrors).toEqual([]);
  });

  test("open document by URL from landing", async ({ page, context }) => {
    // Create a doc first to get a valid URL
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({ timeout: 15_000 });

    // Grab the doc URL from the address bar
    const docUrl = page.url();

    // Open a new page and navigate to landing
    const page2 = await context.newPage();
    await page2.goto("/");

    // Paste the URL and open
    const input = page2.getByLabel("Document capability URL");
    await input.fill(docUrl);
    await page2.locator(".open-form button").click();

    // Should navigate to editor
    await expect(page2.locator(".tiptap")).toBeVisible({ timeout: 15_000 });
    await expect(page2.locator(".back-arrow")).toBeVisible();
  });
});
