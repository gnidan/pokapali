import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3141",
    headless: true,
  },
  webServer: {
    command: "npm run dev",
    port: 3141,
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
