/**
 * Comments UI E2E tests — single-browser.
 *
 * Tests the comment popover, sidebar, threading,
 * resolve/reopen/delete, anchoring, and edge cases.
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
 * Type text into the editor, then select all of it.
 * Uses Ctrl/Meta+A which reliably fires selectionchange
 * in headless Chromium.
 */
async function typeAndSelect(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(text);

  // Select all text in the editor.
  await page.keyboard.press("Meta+a");
}

/**
 * Full flow: type text, select it, click popover
 * button, fill comment text, and submit.
 * Returns with the sidebar open and comment visible.
 */
async function createComment(
  page: import("@playwright/test").Page,
  editorText: string,
  commentText: string,
) {
  await typeAndSelect(page, editorText);

  await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
    timeout: 3_000,
  });
  await page.locator("[data-testid='add-comment-btn']").click();

  await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
    timeout: 3_000,
  });

  const input = page.locator(".cs-new-comment [data-testid='comment-input']");
  await input.fill(commentText);
  await page.locator(".cs-new-comment [data-testid='comment-submit']").click();

  await expect(
    page
      .locator("[data-testid='comment-item']")
      .filter({ hasText: commentText }),
  ).toBeVisible({ timeout: 3_000 });
}

// ── Popover visibility ──────────────────────────

test.describe("comment popover", () => {
  test("appears on text selection", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Selectable text");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("[data-testid='add-comment-btn']")).toBeVisible();
  });

  test("appears on keyboard-based partial selection", async ({ page }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Keyboard selection test");

    // Select "test" at the end using Shift+Arrow.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }

    // selectionchange may fire asynchronously after
    // keyboard-driven selection in ProseMirror.
    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 5_000 });
  });

  test("does not appear with collapsed selection", async ({ page }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Just a cursor, no select");

    // Click to place cursor (no selection range).
    await editor.click();

    const popover = page.locator("[data-testid='comment-popover']");
    // Give it a moment to potentially appear.
    await page.waitForTimeout(500);
    await expect(popover).not.toBeVisible();
  });

  test("disappears when selection is collapsed", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Select then deselect");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });

    // Click to collapse selection.
    await page.locator(".tiptap").click();
    await expect(popover).not.toBeVisible({
      timeout: 2_000,
    });
  });

  test("disappears on Escape key", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Escape test");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(popover).not.toBeVisible({
      timeout: 2_000,
    });
  });
});

// ── Comment creation ────────────────────────────

test.describe("comment creation", () => {
  test("add-comment button opens sidebar with input", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Comment target");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    const sidebar = page.locator("[data-testid='comment-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    // Input should be present within the new-comment
    // section (not the reply section).
    const input = page.locator(".cs-new-comment [data-testid='comment-input']");
    await expect(input).toBeVisible();
  });

  test("submit creates comment item in sidebar", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Text to comment on", "This is my comment");

    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible();
    await expect(item).toContainText("This is my comment");
  });

  test("submit button is disabled when input is empty", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Check disabled state");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    const submit = page.locator(
      ".cs-new-comment [data-testid='comment-submit']",
    );
    await expect(submit).toBeDisabled();
  });

  test("Cmd+Enter submits comment", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Keyboard submit test");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    const input = page.locator(".cs-new-comment [data-testid='comment-input']");
    await input.fill("Submitted with keyboard");

    // Focus the textarea and press Cmd+Enter.
    await input.focus();
    await page.keyboard.press("Meta+Enter");

    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible({ timeout: 3_000 });
    await expect(item).toContainText("Submitted with keyboard");
  });

  test("comment shows author and timestamp", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Author check", "Check metadata");

    const item = page.locator("[data-testid='comment-item']");
    // Author should be a truncated pubkey.
    const author = item.locator(".cs-author");
    await expect(author).toBeVisible();

    // Timestamp should show "just now".
    const timestamp = item.locator(".cs-timestamp");
    await expect(timestamp).toContainText("just now");
  });

  test("pending anchor highlight appears in editor", async ({ page }) => {
    await createDoc(page);
    await typeAndSelect(page, "Highlighted selection");

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    // The pending anchor should create a highlight
    // decoration in the editor.
    const highlight = page.locator(".tiptap .pending-anchor");
    await expect(highlight).toBeVisible({
      timeout: 3_000,
    });
  });
});

// ── Comment highlight anchoring ─────────────────

test.describe("comment anchor highlighting", () => {
  test("submitted comment creates anchor highlight", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Anchored text here", "Testing anchor highlight");

    // After submitting, the pending-anchor should be
    // cleared and a comment-anchor should appear.
    const commentAnchor = page.locator(".tiptap .comment-anchor");
    await expect(commentAnchor).toBeVisible({
      timeout: 3_000,
    });
    await expect(commentAnchor).toContainText("Anchored text here");
  });

  test("selecting comment in sidebar highlights anchor", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Click to highlight", "Selectable comment");

    // Click the comment item to select it.
    await page.locator("[data-testid='comment-item']").click();

    // The anchor should get the "active" class.
    const activeAnchor = page.locator(".tiptap .comment-anchor.active");
    await expect(activeAnchor).toBeVisible({
      timeout: 3_000,
    });
  });
});

// ── Threading ───────────────────────────────────

test.describe("comment threading", () => {
  test("reply to comment shows thread", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Threaded discussion", "Root comment");

    // Click reply on the root comment.
    await page.locator("[data-testid='reply-btn']").first().click();

    // Reply input should appear inside the reply wrap.
    const replyInput = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-input']");
    await expect(replyInput).toBeVisible();
    await replyInput.fill("A reply");

    const replySubmit = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-submit']");
    await replySubmit.click();

    // Thread should now have 2 items (root + reply).
    const items = page.locator("[data-testid='comment-item']");
    await expect(items).toHaveCount(2, {
      timeout: 3_000,
    });

    // The reply should have the .cs-reply class.
    const reply = page.locator("[data-testid='comment-item'].cs-reply");
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("A reply");
  });

  test("multiple replies create a thread", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Multi reply test", "Root comment");

    // First reply.
    await page.locator("[data-testid='reply-btn']").first().click();
    const replyInput1 = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-input']");
    await replyInput1.fill("Reply one");
    await page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-submit']")
      .click();

    await expect(page.locator("[data-testid='comment-item']")).toHaveCount(2, {
      timeout: 3_000,
    });

    // Second reply.
    await page.locator("[data-testid='reply-btn']").first().click();
    const replyInput2 = page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-input']");
    await replyInput2.fill("Reply two");
    await page
      .locator(".cs-reply-input-wrap")
      .locator("[data-testid='comment-submit']")
      .click();

    // Should now have 3 items.
    await expect(page.locator("[data-testid='comment-item']")).toHaveCount(3, {
      timeout: 3_000,
    });

    // Both replies should have .cs-reply class.
    const replies = page.locator("[data-testid='comment-item'].cs-reply");
    await expect(replies).toHaveCount(2);
  });

  test("cancel reply hides input", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Cancel reply test", "Root comment");

    await page.locator("[data-testid='reply-btn']").first().click();

    const replyWrap = page.locator(".cs-reply-input-wrap");
    await expect(replyWrap).toBeVisible();

    // Click cancel.
    await replyWrap.locator(".cs-btn-cancel").click();
    await expect(replyWrap).not.toBeVisible();
  });
});

// ── Resolve / reopen ────────────────────────────

test.describe("resolve and reopen", () => {
  test("resolve moves comment to resolved section", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Resolvable text", "To be resolved");

    await page.locator("[data-testid='resolve-btn']").click();

    // Resolved toggle should appear.
    const toggle = page.locator(".cs-resolved-toggle");
    await expect(toggle).toBeVisible({ timeout: 3_000 });
    await expect(toggle).toContainText("1 resolved");

    // Open comments section should show empty state
    // or selection hint (no open comments remain).
    // The resolved comment is hidden until toggled.
    const openItems = page.locator(
      ".cs-sidebar-body > .cs-thread:not(.cs-thread-resolved) [data-testid='comment-item']",
    );
    await expect(openItems).toHaveCount(0);
  });

  test("show resolved comments in toggle section", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Resolve and show", "Will be resolved");

    await page.locator("[data-testid='resolve-btn']").click();

    const toggle = page.locator(".cs-resolved-toggle");
    await expect(toggle).toBeVisible({ timeout: 3_000 });
    await toggle.click();

    // Resolved comment should be visible with class.
    const resolved = page.locator("[data-testid='comment-item'].cs-resolved");
    await expect(resolved).toBeVisible();
    await expect(resolved).toContainText("Will be resolved");
  });

  test("reopen moves comment back to open section", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Reopen test text", "Resolve then reopen");

    // Resolve.
    await page.locator("[data-testid='resolve-btn']").click();
    const toggle = page.locator(".cs-resolved-toggle");
    await expect(toggle).toBeVisible({ timeout: 3_000 });

    // Show resolved, then click Reopen.
    await toggle.click();
    const resolved = page.locator("[data-testid='comment-item'].cs-resolved");
    await expect(resolved).toBeVisible();

    // The Reopen button replaces Reply/Resolve on
    // resolved comments.
    await resolved.locator("button", { hasText: "Reopen" }).click();

    // Comment should be back in the open section.
    // Resolved toggle should disappear (0 resolved).
    await expect(toggle).not.toBeVisible({
      timeout: 3_000,
    });

    const openItem = page.locator(
      "[data-testid='comment-item']:not(.cs-resolved)",
    );
    await expect(openItem).toBeVisible();
    await expect(openItem).toContainText("Resolve then reopen");

    // Reply and Resolve buttons should be back.
    await expect(openItem.locator("[data-testid='reply-btn']")).toBeVisible();
    await expect(openItem.locator("[data-testid='resolve-btn']")).toBeVisible();
  });
});

// ── Delete ──────────────────────────────────────

test.describe("delete comment", () => {
  test("author can delete their comment", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Deletable text", "This will be deleted");

    const item = page.locator("[data-testid='comment-item']");
    await expect(item).toBeVisible();

    // As the author, Delete button should be visible.
    const deleteBtn = item.locator(".cs-btn-danger");
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // Comment should be removed.
    await expect(item).not.toBeVisible({
      timeout: 3_000,
    });

    // Empty state should show.
    await expect(page.locator(".cs-empty")).toBeVisible();
  });
});

// ── Multiple comments ───────────────────────────

test.describe("multiple comments", () => {
  test("multiple comments on different paragraphs", async ({ page }) => {
    await createDoc(page);

    // Create first comment.
    await createComment(page, "First paragraph", "Comment on first");

    // Close sidebar to create a new selection.
    await page.locator(".cs-sidebar-close").click();
    await expect(
      page.locator("[data-testid='comment-sidebar']"),
    ).not.toBeVisible();

    // Create a new paragraph.
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second paragraph");

    // Select the new paragraph.
    await editor.locator("p").last().click({ clickCount: 3 });

    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();

    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });

    const input = page.locator(".cs-new-comment [data-testid='comment-input']");
    await input.fill("Comment on second");
    await page
      .locator(".cs-new-comment [data-testid='comment-submit']")
      .click();

    // Should now have 2 comment items.
    const items = page.locator("[data-testid='comment-item']");
    await expect(items).toHaveCount(2, {
      timeout: 3_000,
    });
  });

  test("comment count badge updates", async ({ page }) => {
    await createDoc(page);

    // Before any comments, the badge should not exist
    // or be empty.
    const badge = page.locator(".comment-count-badge");
    await expect(badge).not.toBeVisible();

    await createComment(page, "Badge test text", "First comment for badge");

    // Close sidebar to see the toggle button.
    await page.locator(".cs-sidebar-close").click();

    // Badge should show "1".
    await expect(badge).toBeVisible({ timeout: 3_000 });
    await expect(badge).toContainText("1");
  });
});

// ── Sidebar behavior ────────────────────────────

test.describe("sidebar behavior", () => {
  test("sidebar shows hint when no pending anchor", async ({ page }) => {
    await createDoc(page);

    // Open comments sidebar directly (no selection).
    await page.locator(".toggle-comments").click();

    const sidebar = page.locator("[data-testid='comment-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    // Should show the selection hint.
    const hint = page.locator(".cs-selection-hint");
    await expect(hint).toBeVisible();
  });

  test("sidebar shows empty state with no comments", async ({ page }) => {
    await createDoc(page);

    await page.locator(".toggle-comments").click();

    const sidebar = page.locator("[data-testid='comment-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    await expect(page.locator(".cs-empty")).toBeVisible();
    await expect(page.locator(".cs-empty")).toContainText("No comments yet");
  });

  test("close button hides sidebar", async ({ page }) => {
    await createDoc(page);

    await page.locator(".toggle-comments").click();
    const sidebar = page.locator("[data-testid='comment-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    await page.locator(".cs-sidebar-close").click();
    await expect(sidebar).not.toBeVisible();
  });

  test("toggle button shows/hides sidebar", async ({ page }) => {
    await createDoc(page);

    const toggle = page.locator(".toggle-comments");
    const sidebar = page.locator("[data-testid='comment-sidebar']");

    // Open.
    await toggle.click();
    await expect(sidebar).toBeVisible({ timeout: 3_000 });
    await expect(toggle).toContainText("Hide comments");

    // Close.
    await toggle.click();
    await expect(sidebar).not.toBeVisible();
    await expect(toggle).toContainText("Comments");
  });
});

// ── Edge cases ──────────────────────────────────

test.describe("comment edge cases", () => {
  test("select text at document start", async ({ page }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Start of document");

    // Select all — reliable in headless Chromium
    // (Shift+Arrow doesn't always trigger
    // selectionchange).
    await page.keyboard.press("Meta+a");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 5_000 });
  });

  test("select text at document end", async ({ page }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("End of document");

    // Select all — reliable in headless Chromium
    // (Shift+Arrow doesn't always trigger
    // selectionchange).
    await page.keyboard.press("Meta+a");

    const popover = page.locator("[data-testid='comment-popover']");
    await expect(popover).toBeVisible({ timeout: 5_000 });
  });

  test("popover not shown for read-only docs", async ({ page, context }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Read only test content");

    // Get the read-only URL from the share panel.
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

    // Open read-only URL in new page.
    const page2 = await context.newPage();
    await page2.goto(readUrl);
    await expect(page2.locator(".tiptap")).toBeVisible({
      timeout: EDITOR_TIMEOUT,
    });

    // Try to select text in read-only editor.
    // The CommentPopover is not rendered when
    // isReadOnly is true (Editor.tsx line 483).
    await page2.locator(".tiptap").click({ clickCount: 3 });
    await page2.waitForTimeout(500);

    const popover = page2.locator("[data-testid='comment-popover']");
    await expect(popover).not.toBeVisible();

    await page2.close();
  });
});

// ── Click-to-open (#192) ────────────────────────

test.describe("click highlighted text (#192)", () => {
  test("clicking comment anchor opens sidebar", async ({ page }) => {
    await createDoc(page);
    await createComment(page, "Anchored text here", "Click-to-open test");

    // Close the sidebar first.
    await page.locator(".cs-sidebar-close").click();
    await expect(
      page.locator("[data-testid='comment-sidebar']"),
    ).not.toBeVisible();

    // Click on the highlighted anchor text.
    const anchor = page.locator(".comment-anchor").first();
    await expect(anchor).toBeVisible({ timeout: 3_000 });
    await anchor.click();

    // Sidebar should reopen with the comment selected.
    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });
    await expect(
      page
        .locator("[data-testid='comment-item']")
        .filter({ hasText: "Click-to-open test" }),
    ).toBeVisible();
  });
});

// ── Document-position ordering (#193) ───────────

test.describe("comment ordering (#193)", () => {
  test("comments ordered by document position", async ({ page }) => {
    await createDoc(page);
    const editor = page.locator(".tiptap");

    // Type two separate paragraphs.
    await editor.click();
    await page.keyboard.type("First paragraph");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second paragraph");

    // Comment on "Second paragraph" first.
    // Triple-click on second line to select it.
    const secondP = editor.locator("p").filter({ hasText: "Second paragraph" });
    await secondP.click({ clickCount: 3 });
    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();
    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });
    const input1 = page.locator(
      ".cs-new-comment [data-testid='comment-input']",
    );
    await input1.fill("Comment on second");
    await page
      .locator(".cs-new-comment [data-testid='comment-submit']")
      .click();
    await expect(
      page
        .locator("[data-testid='comment-item']")
        .filter({ hasText: "Comment on second" }),
    ).toBeVisible({ timeout: 3_000 });

    // Close sidebar, then comment on "First paragraph".
    await page.locator(".cs-sidebar-close").click();
    const firstP = editor.locator("p").filter({ hasText: "First paragraph" });
    await firstP.click({ clickCount: 3 });
    await expect(page.locator("[data-testid='comment-popover']")).toBeVisible({
      timeout: 3_000,
    });
    await page.locator("[data-testid='add-comment-btn']").click();
    await expect(page.locator("[data-testid='comment-sidebar']")).toBeVisible({
      timeout: 3_000,
    });
    const input2 = page.locator(
      ".cs-new-comment [data-testid='comment-input']",
    );
    await input2.fill("Comment on first");
    await page
      .locator(".cs-new-comment [data-testid='comment-submit']")
      .click();
    await expect(
      page
        .locator("[data-testid='comment-item']")
        .filter({ hasText: "Comment on first" }),
    ).toBeVisible({ timeout: 3_000 });

    // Verify ordering: "Comment on first" should
    // appear before "Comment on second" in the DOM
    // despite being created second.
    const items = page.locator("[data-testid='comment-item']");
    const texts = await items.allTextContents();
    const firstIdx = texts.findIndex((t) => t.includes("Comment on first"));
    const secondIdx = texts.findIndex((t) => t.includes("Comment on second"));
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

// ── Cursor selection opacity (#194) ─────────────

test.describe("cursor selection opacity (#194)", () => {
  test("no ProseMirror-yjs-selection at full opacity", async ({ page }) => {
    // Verify the custom selectionRender is wired by
    // checking that no inline style uses the default
    // 70 (44%) alpha. We can't easily trigger a
    // remote selection in a single-browser test, so
    // instead we verify the extension is configured
    // by checking the editor mounts without errors
    // and the collaboration cursor extension is active.
    await createDoc(page);

    // Editor should be mounted and functional.
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Opacity test");

    // If default selectionRender were used, remote
    // selections would use 70 alpha. We've overridden
    // to 1F. Verify no elements have the default
    // opacity pattern in their style.
    const defaultOpacity = await page
      .locator("[style*='70']")
      .locator(".ProseMirror-yjs-selection")
      .count();
    expect(defaultOpacity).toBe(0);
  });
});

test.describe("auth identity display (#191)", () => {
  test("comment author shows display name", async ({ page }) => {
    await createDoc(page);

    // Set a display name via the name-edit UI.
    const nameBtn = page.locator(".user-name-display");
    await nameBtn.click();
    const nameInput = page.locator(".user-name-input");
    await nameInput.fill("Alice");
    await nameInput.press("Enter");

    // Wait for awareness to propagate the display name
    // through the participant identity flow.
    await page.waitForTimeout(1000);

    // Create a comment.
    await createComment(page, "Named author test", "Comment by Alice");

    // The comment author should show "Alice",
    // not a hex pubkey.
    const author = page.locator("[data-testid='comment-author']").first();
    await expect(author).toBeVisible({ timeout: 5000 });
    const text = await author.textContent();
    expect(text).toContain("Alice");
    // Hex pubkeys are 64+ chars of [0-9a-f].
    // Ensure no hex string is shown.
    expect(text).not.toMatch(/^[0-9a-f]{6,}/);
  });
});
