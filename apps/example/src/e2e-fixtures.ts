/**
 * Playwright test fixture that disables P2P for
 * UI-only E2E tests. Injects a global flag before
 * page scripts run so the app skips Helia/WebRTC
 * initialization.
 *
 * Multi-peer tests should import directly from
 * "@playwright/test" instead.
 */
import { test as base, expect } from "@playwright/test";

export { expect };

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__POKAPALI_NO_P2P = true;
    });
    await use(context);
  },
});
