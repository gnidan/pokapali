import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Workspace packages aliased to local source for fast
// dev iteration. Set POKAPALI_PUBLISHED_DEPS=1 to
// resolve @pokapali/* from node_modules instead (used
// by bin/verify-published-deps.sh to test the published
// package build).
const useLocalPkgs = !process.env.POKAPALI_PUBLISHED_DEPS;
const localPkgs = [
  "comments",
  "comments-tiptap",
  "core",
  "crypto",
  "capability",
  "log",
  "react",
  "subdocs",
  "snapshot",
  "sync",
];

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
  resolve: useLocalPkgs
    ? {
        alias: {
          // CSS subpath export needs its own alias
          // since the index.ts alias swallows it.
          "@pokapali/react/comments.css": path.resolve(
            __dirname,
            "../../packages/react/src/comments.css",
          ),
          "@pokapali/react/indicators.css": path.resolve(
            __dirname,
            "../../packages/react/src/indicators.css",
          ),
          "@pokapali/react/topology-map.css": path.resolve(
            __dirname,
            "../../packages/react/src/topology-map.css",
          ),
          "@pokapali/react/topology": path.resolve(
            __dirname,
            "../../packages/react/src/topology.ts",
          ),
          ...Object.fromEntries(
            localPkgs.map((p) => [
              `@pokapali/${p}`,
              path.resolve(__dirname, `../../packages/${p}/src/index.ts`),
            ]),
          ),
        },
      }
    : {},
}));
