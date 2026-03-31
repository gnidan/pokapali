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

  test("click+drag selects text (#250)", async ({ page }) => {
    // Mouse-coordinate selection is unreliable in
    // headless Chromium on Linux CI.
    test.skip(!!process.env.CI, "click+drag unreliable in headless CI");
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
    await page.keyboard.type("Hello drag selection");

    // Get the bounding box of the editor content
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();

    // Click+drag from start to middle of text
    const startX = box!.x + 10;
    const y = box!.y + 20;
    const endX = box!.x + 120;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 10 });
    await page.mouse.up();

    // Wait for selection to propagate in headless.
    await page.waitForTimeout(100);

    // Verify that a non-collapsed selection exists.
    // Use waitForFunction so ProseMirror has time to
    // process the selection event.
    await page.waitForFunction(
      () => {
        const sel = window.getSelection();
        return sel && !sel.isCollapsed;
      },
      { timeout: 3_000 },
    );
  });

  test("two-pass click+drag selects text (#250)", async ({ page }) => {
    // Mouse-coordinate selection is unreliable in
    // headless Chromium on Linux CI.
    test.skip(!!process.env.CI, "click+drag unreliable in headless CI");
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
    await page.keyboard.type("First line of text for two-pass drag test");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line of text for selection");

    const box = await editor.boundingBox();
    expect(box).not.toBeNull();

    // First drag — select on the first line
    const startX1 = box!.x + 10;
    const y1 = box!.y + 12;
    const endX1 = box!.x + 180;

    await page.mouse.move(startX1, y1);
    await page.mouse.down();
    await page.mouse.move(endX1, y1, { steps: 10 });
    await page.mouse.up();

    await page.waitForFunction(
      () => {
        const sel = window.getSelection();
        return sel && !sel.isCollapsed;
      },
      { timeout: 3_000 },
    );

    // Brief pause — let CommentPopover appear
    await page.waitForTimeout(200);

    // Second drag — select on the second line.
    // This must work even if the popover from the
    // first selection is visible.
    const y2 = box!.y + 38;
    const startX2 = box!.x + 10;
    const endX2 = box!.x + 200;

    await page.mouse.move(startX2, y2);
    await page.mouse.down();
    await page.mouse.move(endX2, y2, { steps: 10 });
    await page.mouse.up();

    await page.waitForFunction(
      () => {
        const sel = window.getSelection();
        return sel && !sel.isCollapsed;
      },
      { timeout: 3_000 },
    );
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
  test("new doc shows save action button", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const save = page.locator(".poka-save-indicator");
    await expect(save).toBeVisible();
    // New doc starts as "Save now" (unpublished) or
    // may race to "Save changes" (dirty) if CRDT
    // initialization triggers a change event.
    await expect(save).toContainText(/Save/);
    // It's a button when publishable.
    await expect(save).toHaveClass(/poka-save-indicator--action/);
  });

  test("typing transitions state to dirty", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Create new document",
      })
      .click();
    await expect(page.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    const save = page.locator(".poka-save-indicator");
    // Wait for initial save state to settle.
    await expect(save).toContainText(/Save/);

    await page.locator(".tiptap").click();
    await page.keyboard.type("Hello");

    await expect(save).toContainText("Save changes", {
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

    const save = page.locator(".poka-save-indicator");
    await expect(save).toContainText("Save changes", {
      timeout: 5_000,
    });

    // Click save — should transition through saving.
    await save.click();

    // Accept any post-click state: "Saving…",
    // "Saved", or "Save failed" (no pinners in
    // test env). The key assertion is that click
    // triggers a state change from "Save changes".
    await expect(save).not.toContainText("Save changes", {
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

    const saveEl = page.locator(".poka-save-indicator");
    await expect(saveEl).toBeVisible();
    await expect(saveEl).toContainText(/Save/);

    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Some content");
    await expect(saveEl).toContainText("Save changes", { timeout: 5_000 });
  });
});
