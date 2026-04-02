/**
 * Playwright globalTeardown — stops the test relay
 * and cleans up the temp file.
 */

import { unlink } from "node:fs/promises";

const RELAY_INFO_PATH =
  process.env.RELAY_INFO_PATH || "/tmp/pokapali-test-relay.json";

export default async function globalTeardown() {
  const relay = (globalThis as Record<string, unknown>).__testRelay as
    | { stop(): Promise<void> }
    | undefined;

  await relay?.stop();

  try {
    await unlink(RELAY_INFO_PATH);
  } catch {
    // File may not exist if setup failed.
  }
}
