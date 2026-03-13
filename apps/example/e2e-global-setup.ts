/**
 * Playwright globalSetup — starts a minimal libp2p
 * relay for multi-browser E2E tests. Writes the
 * relay's multiaddr to a temp file so tests and
 * globalTeardown can read it.
 */

import { writeFile } from "node:fs/promises";
import { createTestRelay } from "@pokapali/test-utils";

const RELAY_INFO_PATH = "/tmp/pokapali-test-relay.json";

export default async function globalSetup() {
  const relay = await createTestRelay();

  await writeFile(
    RELAY_INFO_PATH,
    JSON.stringify({
      multiaddr: relay.multiaddr,
      peerId: relay.peerId,
    }),
  );

  // Store stop function for globalTeardown.
  (globalThis as Record<string, unknown>).__testRelay = relay;
}
