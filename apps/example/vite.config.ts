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
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Only split node_modules — let app code
          // fall into natural chunks from dynamic
          // imports.
          if (!id.includes("node_modules")) return;

          // P2P + crypto networking stack
          if (
            id.includes("/libp2p/") ||
            id.includes("/@libp2p/") ||
            id.includes("/@chainsafe/") ||
            id.includes("/helia/") ||
            id.includes("/@helia/") ||
            id.includes("/multiformats/") ||
            id.includes("/simple-peer/") ||
            id.includes("/y-webrtc/") ||
            id.includes("/uint8arrays/") ||
            id.includes("/it-") ||
            id.includes("/protons") ||
            id.includes("/@multiformats/") ||
            id.includes("/@noble/") ||
            id.includes("/@peculiar/") ||
            id.includes("/asn1") ||
            id.includes("/pvtsutils") ||
            id.includes("/pvutils")
          ) {
            return "p2p";
          }

          // Editor stack (Tiptap + ProseMirror)
          if (
            id.includes("/@tiptap/") ||
            id.includes("/prosemirror-") ||
            id.includes("/diff-match-patch")
          ) {
            return "editor";
          }
        },
      },
    },
  },
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
