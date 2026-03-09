# Building an App with Pokapali

Pokapali is a P2P collaborative document library built on
[Yjs](https://yjs.dev), WebRTC, and IPFS (Helia). It
handles encryption, peer discovery, real-time sync, and
persistent snapshots so you can focus on your app.

## Quick Start

```sh
npm install @pokapali/core
```

### 1. Create a CollabLib instance

```ts
import { createCollabLib } from "@pokapali/core";

const collab = createCollabLib({
  appId: "my-app",
  namespaces: ["content"],
  base: window.location.origin,
});
```

**Options:**
- `appId` — identifier for your app (used for relay
  discovery and room names)
- `namespaces` — named data channels for your doc
  (e.g. `["content"]`, `["text", "canvas"]`)
- `base` — origin + path prefix for generating
  shareable URLs

### 2. Create or open a document

```ts
// Create a new document (you become admin)
const doc = await collab.create();

// Open from a capability URL
const doc = await collab.open(url);
```

Both return a `CollabDoc`. The URL encodes the document
identity and the recipient's access level — there's no
separate auth step.

### 3. Use the Yjs subdoc

Each namespace gives you a standard `Y.Doc`:

```ts
const ydoc = doc.subdoc("content");

// Use any Yjs data type
const ytext = ydoc.getText("main");
ytext.insert(0, "Hello, world!");

// Or with a Yjs-compatible editor (Tiptap, ProseMirror,
// Monaco, CodeMirror, etc.)
const fragment = ydoc.getXmlFragment("default");
```

Changes sync automatically to all connected peers via
WebRTC. No server required for real-time collaboration.

### 4. Awareness (cursors, presence)

```ts
const awareness = doc.awareness;

// Set your local state
awareness.setLocalStateField("user", {
  name: "Alice",
  color: "#f44336",
});

// Listen for remote state
awareness.on("change", () => {
  const states = awareness.getStates();
  // Map<number, { user: { name, color }, ... }>
});
```

This is the standard Yjs awareness protocol — it works
with Tiptap's `CollaborationCursor`, ProseMirror's
cursor plugin, etc.

### 5. Sharing and access control

Every document has up to three URLs with different access
levels:

```ts
doc.adminUrl;  // full control (null if not admin)
doc.writeUrl;  // edit + publish (null if read-only)
doc.readUrl;   // view only (always available)
```

URLs are self-contained capability tokens — the hash
fragment encodes encrypted keys. Anyone with the URL can
access the document at that level without a server.

**Check capabilities:**

```ts
doc.capability.isAdmin;        // boolean
doc.capability.canPushSnapshots; // boolean
doc.capability.namespaces;     // Set<string>
```

**Generate invite links:**

```ts
// Write access to the "content" namespace
const writeInvite = await doc.inviteUrl({
  namespaces: ["content"],
});

// Read-only (no namespaces)
const readInvite = await doc.inviteUrl({
  namespaces: [],
});
```

### 6. Persistence with snapshots

Pokapali persists document state to IPFS as encrypted
snapshots, published via IPNS. This means a document can
be loaded even when the original author is offline.

```ts
// Publish current state
await doc.pushSnapshot();

// Listen for when a snapshot is recommended
// (fires after significant local changes)
doc.on("snapshot-recommended", () => {
  doc.pushSnapshot();
});

// Listen for remote snapshots being applied
doc.on("snapshot-applied", () => {
  console.log("Received update from IPNS");
});
```

### 7. Document status

Pokapali separates connectivity from persistence:

**Connectivity** — `doc.status` tells you whether the
document is connected to peers:

```ts
doc.status;
// "connecting" | "synced" | "receiving" | "offline"

doc.on("status", (status) => {
  // "synced"     — connected, can send and receive
  // "receiving"  — connected read-only (no write cap)
  // "connecting" — establishing peer connections
  // "offline"    — no peers reachable
});
```

**Persistence** — `doc.saveState` tells you whether
local changes have been published to IPFS:

```ts
doc.saveState;
// "saved" | "dirty" | "saving" | "unpublished"

doc.on("save-state", (state) => {
  // "saved"       — snapshot published and acked
  // "dirty"       — local changes not yet published
  // "saving"      — snapshot push in progress
  // "unpublished" — new doc, never published
});
```

### 8. Node diagnostics

`doc.diagnostics()` returns detailed network info
including discovered nodes with their roles:

```ts
const info = doc.diagnostics();

// info.nodes: NodeInfo[]
// Each node has:
//   peerId, short, connected, roles, ackedCurrentCid,
//   lastSeenAt

// Check for connected pinners
const hasPinner = info.nodes.some(
  (n) => n.connected && n.roles.includes("pinner"),
);

// Check for connected relays
const hasRelay = info.nodes.some(
  (n) => n.connected && n.roles.includes("relay"),
);
```

Nodes advertise their roles (`"relay"`, `"pinner"`, or
both) via GossipSub. Use this to show users whether
their changes will be persisted remotely — if no pinner
is connected, warn them.

### 9. Auto-save

The `createAutoSaver` utility handles snapshot publishing
automatically on visibility change, beforeunload, and
debounced `snapshot-recommended` events:

```ts
import { createAutoSaver } from "@pokapali/core";

// Returns a cleanup function
const cleanup = createAutoSaver(doc);

// In React:
useEffect(() => createAutoSaver(doc), [doc]);
```

### 10. Cleanup

Always destroy when done to release WebRTC connections,
awareness rooms, and the shared Helia instance:

```ts
doc.destroy();
```

## Example: Tiptap Integration

```tsx
import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor
  from "@tiptap/extension-collaboration-cursor";

function Editor({ doc }) {
  const ydoc = doc.subdoc("content");

  // Set up awareness (see section 4 above)
  useEffect(() => {
    doc.awareness.setLocalStateField("user", {
      name: "Alice",
      color: "#f44336",
    });
  }, [doc]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider: doc.provider,
        user: { name: "Alice", color: "#f44336" },
      }),
    ],
  });

  return <EditorContent editor={editor} />;
}
```

**Important:** Disable the history plugin when using
Collaboration — Yjs handles undo/redo.

## Example: Plain Yjs (no framework)

```ts
import { createCollabLib } from "@pokapali/core";

const collab = createCollabLib({
  appId: "notes",
  namespaces: ["content"],
  base: window.location.origin,
});

const doc = await collab.create();
const ydoc = doc.subdoc("content");
const ytext = ydoc.getText("body");

// Write
ytext.insert(0, "Hello!");

// Observe remote changes
ytext.observe((event) => {
  console.log("Text changed:", ytext.toString());
});

// Persist
doc.on("snapshot-recommended", () => {
  doc.pushSnapshot();
});

// Share the admin URL
console.log("Share this link:", doc.adminUrl);
```

## URL Routing

Document URLs look like:

```
https://example.com/doc/<ipns-name>#<encoded-keys>
```

The hash fragment contains encrypted capability keys.
The exact URL pattern depends on your app's `base` path.
Here's one approach to detecting doc URLs:

```ts
// Adapt this to your app's base path and routing
const BASE = "/my-app";

function isDocUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname.startsWith(BASE + "/doc/")
    && parsed.hash.length > 1;
}

// Auto-open on page load
if (isDocUrl(window.location.href)) {
  const doc = await collab.open(window.location.href);
}
```

## Version History

```ts
const versions = await doc.history();
// [{ cid, seq, ts }, ...]

// Load a specific version
const subdocs = await doc.loadVersion(versions[0].cid);
// Record<string, Y.Doc> — one Y.Doc per namespace
```

## Tips

- **Multiple namespaces** let you separate concerns
  (e.g. `["text", "metadata"]`) with independent
  write permissions per namespace.
- **`snapshot-recommended`** fires when local changes
  are significant enough to warrant persisting. Hook
  it up to `pushSnapshot()` with a debounce.
- **Capability URLs are secrets** — treat them like
  passwords. The hash fragment is never sent to
  servers, but anyone with the full URL has access.
- **Pokapali nodes** (relays and pinners) are optional.
  Peers connect directly via WebRTC. Relays improve
  discovery and provide GossipSub signaling for peers
  behind NAT. Pinners persist snapshots so documents
  load even when the author is offline.
- **Monitor node health** with `doc.diagnostics().nodes`
  to warn users when no pinners are connected.
