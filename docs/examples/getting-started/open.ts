/**
 * open.ts — Open an existing pokapali document.
 *
 * Demonstrates: app.open(), reading content,
 * subscribing to live updates, and cleanup.
 *
 * NOTE: @pokapali/core requires a browser environment
 * (WebRTC, IndexedDB, Web Crypto). This file shows
 * the API for reading — to run it, use a bundler
 * like Vite that targets the browser.
 */

import { pokapali } from "@pokapali/core";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npx tsx open.ts <url>");
  process.exit(1);
}

// 1. Initialize with the same appId and channels.
const app = pokapali({
  appId: "getting-started",
  channels: ["content"],
  origin: "https://example.com",
});

// 2. Open the document from a capability URL.
//    The URL encodes your access level (admin,
//    write, or read).
const doc = await app.open(url);
const role = doc.capability.isAdmin
  ? "admin"
  : doc.capability.canPushSnapshots
    ? "writer"
    : "reader";
console.log("Opened doc (role: %s)", role);

// 3. Wait for meaningful state to arrive.
//    ready() resolves once content is available
//    (from IndexedDB, peers, or pinner HTTP).
await doc.ready();

// 4. Read the content channel's Y.Doc handle.
import type { Doc as YDoc } from "yjs";
const ydoc = doc.channel("content").handle as YDoc;
const text = ydoc.getText("body");
console.log("Content:", text.toString());

// 5. Subscribe to live edits on the Y.Text.
text.observe((event) => {
  console.log("\n[update] Content:", text.toString());
});

// 6. Subscribe to status changes.
doc.status.subscribe(() => {
  console.log("[status]", doc.status.getSnapshot());
});

console.log("\nListening for changes... (Ctrl+C to quit)");

// Keep the process alive to receive updates.
// In a real app, call doc.destroy() on shutdown.
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  doc.destroy();
  process.exit(0);
});
