import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

// On CI, derive port from PID to avoid collisions when
// concurrent runs share the same VPS. Compute once in
// the main process and share via env — worker processes
// have different PIDs and must not recompute.
if (!process.env.__E2E_PORT && isCI) {
  process.env.__E2E_PORT = String(10_000 + (process.pid % 50_000));
}
const port = Number(process.env.__E2E_PORT || process.env.PORT) || 3141;

// Unique relay info path per run — prevents concurrent
// CI runs from overwriting each other's relay state.
// Same pattern: compute once, share via env.
if (!process.env.RELAY_INFO_PATH) {
  process.env.RELAY_INFO_PATH = `/tmp/pokapali-test-relay-${process.pid}.json`;
}

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.e2e.ts",
  // CI runner is resource-constrained; relay-dependent
  // tests need headroom for IPFS + WebRTC setup.
  timeout: isCI ? 60_000 : 30_000,
  retries: isCI ? 1 : 0,
  // CI: single worker to prevent resource exhaustion.
  // Local: cap at 2 workers — relay-dependent tests
  // (multi-peer, tiers) share a single test relay
  // and concurrent connections overwhelm it.
  workers: isCI ? 1 : 2,
  globalSetup: "./e2e-global-setup.ts",
  globalTeardown: "./e2e-global-teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    // CI: serve the pre-built static output.
    // Dev: run the full Vite HMR dev server.
    command: isCI
      ? `npx vite preview --port ${port}`
      : `PORT=${port} npm run dev`,
    port,
    // CI: never reuse — a stale server from a prior
    // run would serve wrong content. Local: reuse the
    // dev server if already running.
    reuseExistingServer: !isCI,
    timeout: isCI ? 60_000 : 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            // Expose real local IPs in ICE candidates
            // so WebRTC works between browser contexts.
            // Without this, Chromium uses mDNS names
            // that don't resolve across contexts.
            "--disable-features=" + "WebRtcHideLocalIpsWithMdns",
            // Required for headless on CI without
            // a display server.
            "--no-sandbox",
            "--disable-gpu",
            "--font-render-hinting=none",
          ],
        },
      },
    },
  ],
});
