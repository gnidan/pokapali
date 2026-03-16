import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@pokapali/comments": path.resolve(__dirname, "../comments/src/index.ts"),
      "@pokapali/log": path.resolve(__dirname, "../log/src/index.ts"),
    },
  },
});
