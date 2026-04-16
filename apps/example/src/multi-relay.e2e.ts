/**
 * Multi-relay E2E tests.
 *
 * Tests MultiRelayRoom coexistence, relay failover,
 * self-join filtering, and block fetch retry cap.
 * Creates per-test relays (not the global relay)
 * so tests can stop relays mid-flight.
 *
 * S52 B2 — covers S51 changes from !436-!439.
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
// Time for connection state to settle after killing
// a relay. WebSocket close + libp2p reconnect backoff.
const RELAY_SETTLE = 5_000;

// ---- helpers ----

function appUrl(
  baseURL: string,
  relayAddrs: string | string[],
  path = "/",
): string {
  const url = new URL(path, baseURL);
  const peers = Array.isArray(relayAddrs) ? relayAddrs.join(",") : relayAddrs;
  url.searchParams.set("bootstrapPeers", peers);
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
  relayAddrs: string | string[],
) {
  await page.goto(appUrl(baseURL, relayAddrs));
  await clearIDB(page);
  await page.goto(appUrl(baseURL, relayAddrs));
  await page.getByRole("button", { name: "Create new document" }).click();
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

async function openDocViaRelay(
  page: import("@playwright/test").Page,
  writeUrl: string,
  relayAddrs: string | string[],
) {
  const url = new URL(writeUrl);
  const peers = Array.isArray(relayAddrs) ? relayAddrs.join(",") : relayAddrs;
  url.searchParams.set("bootstrapPeers", peers);
  await page.goto(url.toString());
  await clearIDB(page);
  await page.goto(url.toString());
  await expect(page.locator(".tiptap")).toBeVisible({
    timeout: EDITOR_TIMEOUT,
  });
}

/**
 * Verify document sync by having `writer` type a canary
 * token and confirming `reader` sees it, then clean up.
 */
async function waitForDocSync(
  writer: import("@playwright/test").Page,
  reader: import("@playwright/test").Page,
  canary: string,
) {
  await writer.locator(".tiptap").click();
  await writer.keyboard.type(canary);
  await expect(reader.locator(".tiptap")).toContainText(canary, {
    timeout: SYNC_TIMEOUT,
  });
  // Clean up canary.
  await writer.keyboard.press("ControlOrMeta+a");
  await writer.keyboard.press("Backspace");
  await expect(reader.locator(".tiptap")).not.toContainText(canary, {
    timeout: SYNC_TIMEOUT,
  });
}

// ---- tests ----

test.describe("multi-relay", () => {
  test.slow();

  test(
    "coexistence: two peers on two relays discover " + "each other and sync",
    async ({ browser }) => {
      const baseURL = test.info().project.use.baseURL!;

      const relay1 = await createTestRelay();
      const relay2 = await createTestRelay();
      const addrs = [relay1.multiaddr, relay2.multiaddr];

      const aliceCtx = await browser.newContext();
      const alice = await aliceCtx.newPage();
      const bobCtx = await browser.newContext();
      const bob = await bobCtx.newPage();

      try {
        await createDocViaRelay(alice, baseURL, addrs);
        const writeUrl = await getWriteUrl(alice);
        await openDocViaRelay(bob, writeUrl, addrs);

        // Awareness: exactly 2 users (not 4 from
        // duplicate relay paths).
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

        // CRDT sync canary.
        await waitForDocSync(alice, bob, "MR_SYNC");

        // Real content exchange.
        await alice.locator(".tiptap").click();
        await alice.keyboard.type("Alice-multi-relay");

        await bob.locator(".tiptap").click();
        await bob.keyboard.type("Bob-multi-relay");

        await expect(alice.locator(".tiptap")).toContainText(
          "Bob-multi-relay",
          {
            timeout: SYNC_TIMEOUT,
          },
        );
        await expect(bob.locator(".tiptap")).toContainText(
          "Alice-multi-relay",
          {
            timeout: SYNC_TIMEOUT,
          },
        );
      } finally {
        await aliceCtx.close();
        await bobCtx.close();
        await relay1.stop();
        await relay2.stop();
      }
    },
  );

  test(
    "failover: peers stay connected after one " + "relay dies",
    async ({ browser }) => {
      const baseURL = test.info().project.use.baseURL!;

      const relay1 = await createTestRelay();
      const relay2 = await createTestRelay();
      const addrs = [relay1.multiaddr, relay2.multiaddr];

      const aliceCtx = await browser.newContext();
      const alice = await aliceCtx.newPage();
      const bobCtx = await browser.newContext();
      const bob = await bobCtx.newPage();

      try {
        await createDocViaRelay(alice, baseURL, addrs);
        const writeUrl = await getWriteUrl(alice);
        await openDocViaRelay(bob, writeUrl, addrs);

        // Establish baseline: both connected.
        await expect(
          alice.locator("[data-testid='cs-users-count']"),
        ).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });
        await waitForDocSync(alice, bob, "FAILOVER_PRE");

        // Kill relay1.
        await relay1.stop();

        // Brief settle for WebSocket close to propagate
        // and MultiRelayRoom to remove the dead relay.
        await new Promise((r) => setTimeout(r, RELAY_SETTLE));

        // Still connected via relay2.
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

        // Doc sync still works through surviving relay.
        await alice.locator(".tiptap").click();
        await alice.keyboard.type("After-failover");
        await expect(bob.locator(".tiptap")).toContainText("After-failover", {
          timeout: SYNC_TIMEOUT,
        });
      } finally {
        await aliceCtx.close();
        await bobCtx.close();
        // relay1 already stopped; safe to call again.
        await relay1.stop();
        await relay2.stop();
      }
    },
  );

  test(
    "self-join filtering: peer count accurate " + "with multi-relay echo paths",
    async ({ browser }) => {
      const baseURL = test.info().project.use.baseURL!;

      // Two relays = more signaling echo paths.
      // Without self-join filtering, each browser
      // would see its own peerId echoed back through
      // the second relay and inflate the count.
      const relay1 = await createTestRelay();
      const relay2 = await createTestRelay();
      const addrs = [relay1.multiaddr, relay2.multiaddr];

      const aliceCtx = await browser.newContext();
      const alice = await aliceCtx.newPage();
      const bobCtx = await browser.newContext();
      const bob = await bobCtx.newPage();
      const carolCtx = await browser.newContext();
      const carol = await carolCtx.newPage();

      try {
        await createDocViaRelay(alice, baseURL, addrs);
        const writeUrl = await getWriteUrl(alice);
        await openDocViaRelay(bob, writeUrl, addrs);

        // Two peers: count must be exactly 2.
        // If self-join filtering were broken, relay
        // echo would inflate to 3 or 4.
        const aliceUsers = alice.locator("[data-testid='cs-users-count']");
        const bobUsers = bob.locator("[data-testid='cs-users-count']");

        await expect(aliceUsers).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });
        await expect(bobUsers).toContainText("2 users editing", {
          timeout: SYNC_TIMEOUT,
        });

        // Wait for potential delayed self-echo to
        // arrive and (incorrectly) inflate count.
        await new Promise((r) => setTimeout(r, RELAY_SETTLE));

        // Re-check: still exactly 2, not inflated.
        let aliceText = await aliceUsers.textContent();
        expect(aliceText).toContain("2 users");
        expect(aliceText).not.toMatch(/[3-9] users/);

        // Add Carol — count should be exactly 3.
        await openDocViaRelay(carol, writeUrl, addrs);

        for (const users of [
          aliceUsers,
          bobUsers,
          carol.locator("[data-testid='cs-users-count']"),
        ]) {
          await expect(users).toContainText("3 users editing", {
            timeout: SYNC_TIMEOUT,
          });
        }

        // Final check: no inflation from 3 echoed
        // peerIds across 2 relays.
        await new Promise((r) => setTimeout(r, RELAY_SETTLE));
        aliceText = await aliceUsers.textContent();
        expect(aliceText).toContain("3 users");
        expect(aliceText).not.toMatch(/[4-9] users/);
      } finally {
        await carolCtx.close();
        await bobCtx.close();
        await aliceCtx.close();
        await relay1.stop();
        await relay2.stop();
      }
    },
  );

  // NOTE: block fetch retry cap (scenario 4) is not
  // tested at E2E level. Block fetches go through IPFS
  // bitswap (WebSocket), which has 15s timeouts × 3
  // internal retries per fetchBlock() call. Playwright
  // cannot intercept WebSocket traffic or control
  // bitswap timeouts, making the test take 2+ minutes
  // minimum. The retry cap is covered by unit tests in
  // interpreter.test.ts, fetch-block.test.ts, and
  // block-resolver.test.ts. See PM flag for details.
});
