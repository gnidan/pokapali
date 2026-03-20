/**
 * Playwright globalSetup — starts a minimal libp2p
 * relay for multi-browser E2E tests. Writes the
 * relay's multiaddr to a temp file so tests and
 * globalTeardown can read it.
 */

import { writeFile } from "node:fs/promises";
import { createTestRelay } from "@pokapali/test-utils";

const RELAY_INFO_PATH = "/tmp/pokapali-test-relay.json";

/** Mock pinner URL used by tier-badge E2E tests.
 *  Tests intercept requests to this origin via
 *  page.route(). */
const MOCK_PINNER_URL = "http://mock-pinner.test";

export default async function globalSetup() {
  const relay = await createTestRelay({
    httpUrl: MOCK_PINNER_URL,
  });

  await writeFile(
    RELAY_INFO_PATH,
    JSON.stringify({
      multiaddr: relay.multiaddr,
      peerId: relay.peerId,
      httpUrl: MOCK_PINNER_URL,
    }),
  );

  // Store stop function for globalTeardown.
  (globalThis as Record<string, unknown>).__testRelay = relay;
}
