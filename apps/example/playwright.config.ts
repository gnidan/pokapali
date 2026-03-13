import { defineConfig } from "@playwright/test";

const port = Number(process.env.PORT) || 3141;

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    command: `PORT=${port} npm run dev`,
    port,
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
