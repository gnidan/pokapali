import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const pkgs = ["core", "crypto", "capability", "subdocs", "snapshot", "sync"];

export default defineConfig(({ command }) => ({
  server: {
    port: Number(process.env.PORT) || 3141,
    strictPort: true,
  },
  base: command === "build" ? "/pokapali/" : "/",
  build: { target: "es2020" },
  plugins: [react()],
  resolve: {
    alias: Object.fromEntries(
      pkgs.map((p) => [
        `@pokapali/${p}`,
        path.resolve(__dirname, `../../packages/${p}/src/index.ts`),
      ]),
    ),
  },
}));
