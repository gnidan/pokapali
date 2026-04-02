/**
 * Playwright globalSetup — starts a minimal libp2p
 * relay for multi-browser E2E tests. Writes the
 * relay's multiaddr to a temp file so tests and
 * globalTeardown can read it.
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

import { writeFile } from "node:fs/promises";
import { createTestRelay } from "@pokapali/test-utils";

const RELAY_INFO_PATH =
  process.env.RELAY_INFO_PATH || "/tmp/pokapali-test-relay.json";

/** Mock pinner URL used by tier-badge E2E tests.
 *  Tests intercept requests to this origin via
 *  page.route(). */
const MOCK_PINNER_URL = "http://mock-pinner.test";

export default async function globalSetup() {
  let relay;
  try {
    relay = await createTestRelay({
      httpUrl: MOCK_PINNER_URL,
    });
  } catch (err) {
    console.error("[globalSetup] createTestRelay failed:", err);
    throw err;
  }

  try {
    await writeFile(
      RELAY_INFO_PATH,
      JSON.stringify({
        multiaddr: relay.multiaddr,
        peerId: relay.peerId,
        httpUrl: MOCK_PINNER_URL,
      }),
    );
  } catch (err) {
    console.error("[globalSetup] writeFile failed:", err);
    throw err;
  }

  console.log("[globalSetup] relay started:", relay.multiaddr);

  // Store stop function for globalTeardown.
  (globalThis as Record<string, unknown>).__testRelay = relay;
}
