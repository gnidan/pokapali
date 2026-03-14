# E2E Testing Patterns

Playwright E2E tests for `apps/example`. Chromium
headless only, 30s default timeout, zero retries.

## File layout

Tests live in `apps/example/src/*.e2e.ts` alongside
the modules they exercise. Current files:

| File                   | Tests | Covers                            |
| ---------------------- | ----- | --------------------------------- |
| App.e2e.ts             | ~72   | Smoke, publish, connection status |
| comments.e2e.ts        | ~35   | Comments CRUD, anchors, styling   |
| share-flow.e2e.ts      | 2     | Share URLs, bidirectional sync    |
| multi-peer.e2e.ts      | 4     | CRDT convergence, late join       |
| doc-loading.e2e.ts     | 8     | Landing, nav, roles, read-only    |
| version-history.e2e.ts | 4     | Publish versions, restore         |

## Helpers

### `clearIDB(page)`

Deletes all IndexedDB databases so each test starts
clean. Call before first navigation.

```typescript
async function clearIDB(page: Page) {
  await page.evaluate(async () => {
    if ("databases" in indexedDB) {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    }
  });
}
```

### `createDoc(page)`

Navigate to landing, clear IDB, create doc, wait
for `.tiptap` editor to appear.

```typescript
async function createDoc(page: Page) {
  await page.goto("/");
  await clearIDB(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Create new document" }).click();
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}
```

### `typeAndSelect(page, text)`

Type text into the editor, then select all with
`Meta+A`. Prefer this over `Shift+Arrow` — see
quirks below.

### `createComment(page, editorText, commentText)`

Full flow: type → select → popover → submit comment.
Returns with sidebar open and comment visible.

### `getWriteUrl(page)`

Opens share panel, reads the **title** attribute of
the write-URL input (display is truncated), closes
panel, returns full URL string.

### `createDocViaRelay(page, baseURL, relayAddr)`

Like `createDoc` but navigates with `?bootstrapPeers=`
query param for multi-peer tests.

### `openDocViaRelay(page, writeUrl, relayAddr)`

Open an existing doc URL with relay param appended.

### `typeAndPublish(page, text)`

Type content, wait for "Publish" label in
`.save-state`, click it, wait for `.save-action`
class to disappear.

## `data-testid` selectors

```
add-comment-btn        comment-popover button
comment-author         author display in comment
comment-input          comment text field
comment-item           individual comment
comment-popover        selection popover
comment-sidebar        sidebar container
comment-submit         submit button
cs-network-status      network status dot
cs-node-status         IPFS node status dot
cs-users-count         user count display
reply-btn              reply button
resolve-btn            resolve button
share-panel            share URL panel
share-toggle           share panel toggle
vh-entry               version history entry
vh-restore             restore button in preview
```

## CSS class selectors (common)

**Editor:** `.tiptap`, `.landing`, `.back-arrow`,
`.badge`, `.doc-title`, `.connection-status`

**Comments sidebar:** `.cs-new-comment`,
`.cs-reply-input-wrap`, `.cs-sidebar-body`,
`.cs-sidebar-close`, `.cs-thread`,
`.cs-thread-resolved`, `.cs-resolved-toggle`,
`.cs-author`, `.cs-timestamp`, `.cs-empty`,
`.cs-selection-hint`, `.cs-btn-cancel`,
`.cs-btn-danger`

**Save/Publish:** `.save-state`, `.save-action`

**Share:** `.share-card`, `.share-card-label`,
`.open-form`

**Comment anchors:** `.comment-anchor`,
`.pending-anchor`, `.comment-anchor.active`,
`.comment-count-badge`

**Version history:** `.toggle-history`, `.vh-drawer`,
`.vh-empty`, `.version-preview-overlay`,
`.vpo-editor`, `.vh-confirm-ok`

## Timeout constants

```typescript
const EDITOR_TIMEOUT = 8_000; // Helia bootstrap
const SYNC_TIMEOUT = 15_000; // WebRTC + GossipSub
const PUBLISH_TIMEOUT = 10_000; // Snapshot creation
```

Most `toBeVisible()` / `toHaveCount()` calls use
3–5s inline timeouts. Multi-peer tests mark
`test.slow()` to triple the 30s budget.

## Patterns

### Double navigation for clean state

```typescript
await page.goto("/");
await clearIDB(page);
await page.goto("/"); // re-navigate after clearing
```

IDB must be cleared before the app initializes so
persistence doesn't bleed between tests.

### Multi-browser context (multi-peer)

```typescript
const aliceCtx = await browser.newContext();
const alice = await aliceCtx.newPage();
const bobCtx = await browser.newContext();
const bob = await bobCtx.newPage();
try {
  // each context gets its own Helia node
} finally {
  await aliceCtx.close();
  await bobCtx.close();
}
```

### Waiting for state changes

```typescript
// Wait for class to disappear (publish complete):
await expect(el).not.toHaveClass(/save-action/, {
  timeout: PUBLISH_TIMEOUT,
});

// Wait for either of two possible states:
await expect(
  page.locator(".cs-no-pinner").or(page.locator(".cs-checking-pinners")),
).toBeVisible({ timeout: 10_000 });
```

### Element ordering verification

```typescript
const texts = await items.allTextContents();
const firstIdx = texts.findIndex((t) => t.includes("first"));
const secondIdx = texts.findIndex((t) => t.includes("second"));
expect(firstIdx).toBeLessThan(secondIdx);
```

### CSS assertions

```typescript
await expect(btn).toHaveCSS("border-radius", "6px");
await expect(btn).toHaveCSS("background-color", "rgb(255, 255, 255)");
```

Values must be computed CSS (rgb not hex, px not em).

### Conditional skip

```typescript
if (!readUrl) {
  test.skip(true, "Could not get read URL");
  return;
}
```

## Known quirks

### 1. `Meta+A` not `Shift+Arrow` for selection

Headless Chromium doesn't reliably fire
`selectionchange` on `Shift+Arrow` keystrokes.
Use `Meta+A` (select all) or triple-click for
paragraph selection.

### 2. `dispatchEvent("click")` for overlapped targets

When z-index stacking blocks `.click()`, use:

```typescript
await btn.dispatchEvent("click");
```

See `version-history.e2e.ts` restore confirm.

### 3. `waitForTimeout` for negative assertions

To assert something does **not** appear, give it a
moment first:

```typescript
await page.waitForTimeout(500);
await expect(popover).not.toBeVisible();
```

Also used for awareness propagation delays (~1s).

### 4. `getAttribute("title")` for full URLs

Share panel inputs truncate displayed text. Read the
`title` attribute for the full capability URL.

### 5. Comment CSS overlap

`.cs-comment-item` can intercept clicks on nearby
buttons when comments stack. If a click test fails
with "intercept", check for CSS overlap issues.

## Global setup

`e2e-global-setup.ts` starts a test relay via
`createTestRelay()` from `@pokapali/test-utils` and
writes `{ multiaddr, peerId }` to
`/tmp/pokapali-test-relay.json`.

`e2e-global-teardown.ts` stops the relay and deletes
the temp file.

Multi-peer tests read the relay info with
`loadRelayInfo()` and pass the multiaddr as a
`?bootstrapPeers=` query parameter.

## Ownership policy

**Author writes E2E tests, testing reviews.** When
implementing a UX fix or feature, the implementing
role writes the E2E test. Testing role reviews for
coverage gaps and pattern adherence.
