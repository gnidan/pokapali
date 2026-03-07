import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@pokapali/subdocs": path.resolve(
        __dirname, "../subdocs/src/index.ts"
      ),
      "@pokapali/crypto": path.resolve(
        __dirname, "../crypto/src/index.ts"
      ),
    },
  },
});
