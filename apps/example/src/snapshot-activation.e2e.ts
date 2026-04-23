/**
 * Snapshot activation E2E smoke test.
 *
 * Proves the publish pipeline end-to-end in a real
 * browser: Alice types content, CRDT-syncs to Bob
 * via WebRTC, then publishes. The test verifies:
 *   - CRDT sync (Bob sees Alice's content)
 *   - Publish lifecycle (save indicator transitions)
 *   - Peer awareness ("2 users editing")
 *
 * Note: passive-peer snapshot RECEPTION cannot be
 * verified in the current E2E relay infrastructure.
 * GossipSub mesh never forms between browser ↔
 * relay (relay doesn't subscribe to announce topics),
 * IPNS resolution fails (no DHT between browsers),
 * and the reconciliation data channel's snapshot
 * exchange path hasn't been confirmed working in
 * this setup. The passive-peer activation assertion
 * is covered by D4a (Node integration test) where
 * both runtimes share a process.
 *
 * S54 D4b.
 */

// Polyfill for Node < 22 (libp2p deps require it)
if (typeof Promise.withResolvers !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import { test, expect } from "@playwright/test";
import { createTestRelay } from "@pokapali/test-utils";

const EDITOR_TIMEOUT = 8_000;
const SYNC_TIMEOUT = 30_000;
const PUBLISH_TIMEOUT = 45_000;

// ---- helpers ----

function appUrl(baseURL: string, relayAddr: string, path = "/"): string {
  const url = new URL(path, baseURL);
  url.searchParams.set("bootstrapPeers", relayAddr);
  return url.toString();
}

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

async function getWriteUrl(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.locator("[data-testid='share-toggle']").click();
  await expect(page.locator("[data-testid='share-panel']")).toBeVisible();

  const writeCard = page.locator(".share-card", {
    has: page.locator(".share-card-label", {
      hasText: "Write",
    }),
  });
  const url = await writeCard.locator("input").getAttribute("title");

  await page.locator("[data-testid='share-toggle']").click();

  if (!url) throw new Error("Write URL not found");
  return url;
}

async function createDocViaRelay(
  page: import("@playwright/test").Page,
  baseURL: string,
  relayAddr: string,
) {
  await page.goto(appUrl(baseURL, relayAddr));
  await clearIDB(page);
  await page.goto(appUrl(baseURL, relayAddr));
  await page.getByRole("button", { name: "Create new document" }).click();
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

async function openDocViaRelay(
  page: import("@playwright/test").Page,
  writeUrl: string,
  relayAddr: string,
) {
  const url = new URL(writeUrl);
  url.searchParams.set("bootstrapPeers", relayAddr);
  await page.goto(url.toString());
  await clearIDB(page);
  await page.goto(url.toString());
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

/**
 * Type text and publish via the save indicator button.
 * Waits for the save indicator to become actionable
 * (dirty/unpublished), clicks it, then waits for the
 * publish to complete.
 */
async function typeAndPublish(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.type(text);

  const save = page.locator(".poka-save-indicator");
  // Wait for actionable state (dirty or unpublished)
  // — NOT /Save/ which also matches "Saved".
  await expect(save).toHaveClass(/poka-save-indicator--action/, {
    timeout: 5_000,
  });
  await save.click();
  await expect(save).not.toHaveClass(/poka-save-indicator--action/, {
    timeout: PUBLISH_TIMEOUT,
  });
}

// ---- tests ----

test.describe("snapshot activation", () => {
  test.slow();

  test(
    "publish lifecycle: author publishes, " +
      "CRDT syncs to peer, save state transitions",
    async ({ browser }) => {
      const baseURL = test.info().project.use.baseURL!;
      const relay = await createTestRelay();

      const aliceCtx = await browser.newContext();
      const alice = await aliceCtx.newPage();
      const bobCtx = await browser.newContext();
      const bob = await bobCtx.newPage();

      try {
        // Alice creates doc.
        await createDocViaRelay(alice, baseURL, relay.multiaddr);

        // Bob joins the same doc.
        const writeUrl = await getWriteUrl(alice);
        await openDocViaRelay(bob, writeUrl, relay.multiaddr);

        // Wait for peer discovery.
        await expect(
          alice.locator("[data-testid='cs-users-count']"),
        ).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });
        await expect(
          bob.locator("[data-testid='cs-users-count']"),
        ).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });

        // Alice types content — CRDT sync delivers
        // it to Bob via the awareness data channel.
        await alice.locator(".tiptap").click();
        await alice.keyboard.type("Hello from Alice");

        // Bob sees Alice's content (CRDT sync).
        await expect(bob.locator(".tiptap")).toContainText("Hello from Alice", {
          timeout: SYNC_TIMEOUT,
        });

        // Alice publishes — save indicator
        // transitions through the full lifecycle:
        //   dirty → saving → saved
        const aliceSave = alice.locator(".poka-save-indicator");

        // Save indicator shows actionable state.
        await expect(aliceSave).toHaveClass(/poka-save-indicator--action/, {
          timeout: 5_000,
        });

        // Click publish.
        await aliceSave.click();

        // Wait for publish to complete — save
        // indicator loses actionable state and
        // transitions to "saved".
        await expect(aliceSave).toHaveClass(/poka-save-indicator--saved/, {
          timeout: PUBLISH_TIMEOUT,
        });

        // Sanity: Alice's editor still has content.
        await expect(alice.locator(".tiptap")).toContainText(
          "Hello from Alice",
        );
      } finally {
        await aliceCtx.close();
        await bobCtx.close();
        await relay.stop();
      }
    },
  );
});
