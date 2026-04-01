import { defineConfig } from "@playwright/test";

const port = Number(process.env.PORT) || 3141;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: isCI ? 1 : 0,
  // Single worker on CI to prevent resource
  // exhaustion (each test spins up Chromium).
  workers: isCI ? 1 : undefined,
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
    reuseExistingServer: true,
    timeout: 30_000,
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
