import { describe, it, expect, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./test-relay.js";

describe("createTestRelay", () => {
  let relay: TestRelay | undefined;

  afterEach(async () => {
    await relay?.stop();
    relay = undefined;
  });

  it("starts and returns a multiaddr", async () => {
    relay = await createTestRelay();

    expect(relay.multiaddr).toMatch(
      /^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/ws\/p2p\//,
    );
    expect(relay.peerId).toBeTruthy();
  });

  it("uses a random port by default", async () => {
    relay = await createTestRelay();
    const relay2 = await createTestRelay();

    try {
      expect(relay.multiaddr).not.toBe(relay2.multiaddr);
    } finally {
      await relay2.stop();
    }
  });

  it("uses a specified port", async () => {
    relay = await createTestRelay({ port: 19876 });

    expect(relay.multiaddr).toContain("/tcp/19876/");
  });

  it("stop shuts down cleanly", async () => {
    relay = await createTestRelay();
    await relay.stop();

    // Should not throw on double stop.
    await relay.stop();
    relay = undefined;
  });
});
