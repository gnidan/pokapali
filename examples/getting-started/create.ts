/**
 * create.ts — Create a new pokapali document.
 *
 * Demonstrates: pokapali() setup, app.create(),
 * channel access, Y.Text editing, publishing,
 * and generating invite URLs.
 *
 * Usage: npx tsx create.ts
 */

// Replace "file:../../packages/core" with
// "@pokapali/core" after npm publish.
import { pokapali } from "@pokapali/core";

// 1. Initialize the pokapali app.
//    - appId: scopes relay discovery and key
//      derivation; use the same value across all
//      clients of your app.
//    - channels: named Yjs subdocs for your data.
//    - origin: base URL for capability links.
const app = pokapali({
  appId: "getting-started",
  channels: ["content"],
  origin: "https://example.com",
});

// 2. Create a new document. You become admin.
const doc = await app.create();
console.log("Created doc!");
console.log("  Admin URL:", doc.urls.admin);
console.log("  Write URL:", doc.urls.write);
console.log("  Read URL: ", doc.urls.read);

// 3. Access the "content" channel as a Y.Doc.
//    Use any Yjs shared type (Y.Text, Y.Map, etc.).
const ydoc = doc.channel("content");
const text = ydoc.getText("body");
text.insert(0, "Hello from pokapali!");
console.log("\nContent:", text.toString());

// 4. Subscribe to status and save-state feeds.
//    Feeds are { getSnapshot(), subscribe() } —
//    compatible with React's useSyncExternalStore.
const unsubStatus = doc.status.subscribe(() => {
  console.log("Status:", doc.status.getSnapshot());
});
const unsubSave = doc.saveState.subscribe(() => {
  console.log("Save:", doc.saveState.getSnapshot());
});

// 5. Publish the current state as a snapshot.
//    This creates an immutable, content-addressed
//    block that pinners can replicate.
await doc.publish();
console.log("\nPublished snapshot.");

// 6. Generate a write-only invite URL.
//    The recipient can edit but not grant access.
const writeUrl = await doc.invite({
  channels: ["content"],
  canPushSnapshots: true,
});
console.log("\nWrite invite URL:", writeUrl);
console.log("\nShare this URL, then run:", `\n  npx tsx open.ts "${writeUrl}"`);

// 7. Clean up when done.
unsubStatus();
unsubSave();
doc.destroy();
