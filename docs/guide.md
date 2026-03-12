# Building an App with Pokapali

Pokapali is a P2P collaborative document library built on
[Yjs](https://yjs.dev), WebRTC, and IPFS (Helia). It
handles encryption, peer discovery, real-time sync, and
persistent snapshots so you can focus on your app.

## Quick Start

```sh
npm install @pokapali/core
```

### 1. Create a PokapaliApp instance

```ts
import { pokapali } from "@pokapali/core";

const app = pokapali({
  appId: "my-app",
  channels: ["content"],
  origin: window.location.origin,
});
```

**Options:**

| Option           | Type       | Required | Default         | Description                                                                                                                                                                                        |
| ---------------- | ---------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`          | `string`   | No       | `""`            | App identifier used for relay discovery, GossipSub topic namespacing, and HKDF key derivation. Public — not a secret. Different apps with the same `appId` share pinners and relay infrastructure. |
| `channels`       | `string[]` | **Yes**  | —               | Named data channels. Each becomes its own `Y.Doc` with independent write access. E.g. `["content"]`, `["text", "comments"]`.                                                                       |
| `primaryChannel` | `string`   | No       | `channels[0]`   | Which channel gates `_meta` room access. Peers who can write to the primary channel can modify access allowlists. Usually the main content channel.                                                |
| `origin`         | `string`   | **Yes**  | —               | Origin + path prefix for generating shareable URLs (e.g. `window.location.origin` or `"https://example.com/app"`).                                                                                 |
| `rtc`            | `object`   | No       | —               | WebRTC peer connection options passed to `simple-peer` (e.g. custom ICE servers).                                                                                                                  |
| `signalingUrls`  | `string[]` | No       | `[]`            | Additional WebSocket signaling server URLs. Empty by default — signaling uses GossipSub via libp2p, not WebSocket servers.                                                                         |
| `bootstrapPeers` | `string[]` | No       | libp2p defaults | Override libp2p bootstrap peer multiaddrs. Rarely needed — the defaults connect to the public libp2p network.                                                                                      |

### 2. Create or open a document

```ts
// Create a new document (you become admin)
const doc = await app.create();

// Open from a capability URL
const doc = await app.open(url);
```

Both return a `Doc`. The URL encodes the document
identity and the recipient's access level — there's no
separate auth step.

### 3. Use the Yjs channel

Each channel gives you a standard `Y.Doc`:

```ts
const ydoc = doc.channel("content");

// Use any Yjs data type
const ytext = ydoc.getText("main");
ytext.insert(0, "Hello, world!");

// Or with a Yjs-compatible editor (Tiptap,
// ProseMirror, Monaco, CodeMirror, etc.)
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
doc.urls.admin; // full control (null if not admin)
doc.urls.write; // edit + publish (null if read-only)
doc.urls.read; // view only (always available)
```

URLs are self-contained capability tokens — the hash
fragment encodes encrypted keys. Anyone with the URL can
access the document at that level without a server.

**Check capabilities:**

```ts
doc.capability.isAdmin; // boolean
doc.capability.canPushSnapshots; // boolean
doc.capability.channels; // Set<string>
```

**Generate invite links:**

```ts
// Write access to the "content" channel
const writeInvite = await doc.invite({
  channels: ["content"],
});

// Read-only (no channels)
const readInvite = await doc.invite({
  channels: [],
});
```

### 6. Persistence with snapshots

Pokapali persists document state to IPFS as encrypted
snapshots, published via IPNS. This means a document can
be loaded even when the original author is offline.

```ts
// Publish current state
await doc.publish();

// Listen for when publishing is recommended
// (fires after significant local changes)
doc.on("publish-needed", () => {
  doc.publish();
});

// Listen for snapshots (local publishes + remote)
doc.on("snapshot", ({ cid, seq, ts, isLocal }) => {
  if (isLocal) {
    console.log("Published snapshot:", cid.toString());
  } else {
    console.log("Received remote snapshot:", cid);
  }
});
```

**Block distribution:** Snapshots up to 1 MB are
distributed inline via GossipSub announcements. Larger
snapshots (1–6 MB) are uploaded to connected pinners
via HTTP POST and fetched by readers via HTTP GET. This
is transparent — `publish()` and snapshot fetching
handle it automatically.

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

doc.on("save", (state) => {
  // "saved"       — snapshot published and acked
  // "dirty"       — local changes not yet published
  // "saving"      — snapshot push in progress
  // "unpublished" — new doc, never published
});
```

**Additional events** for network visualization:

```ts
// Block fetch progress (IPNS resolve, block fetch)
doc.on("loading", (state) => {
  // state.status: "idle" | "resolving" |
  //   "fetching" | "retrying" | "failed"
});

// GossipSub activity changes
doc.on("gossip-activity", (activity) => {
  // "inactive" | "subscribed" | "receiving"
});

// Outbound guarantee query sent to pinners
doc.on("guarantee-query", () => {});

// Pinner acknowledged current snapshot
doc.on("ack", (peerId) => {});

// Infrastructure node discovered or changed
doc.on("node-change", () => {});
```

### 8. Reactive Feeds

For framework integration (especially React), each
status property has a corresponding `Feed<T>` that
works directly with `useSyncExternalStore`:

```ts
import { useSyncExternalStore } from "react";

// Status indicator
function StatusBadge({ doc }) {
  const status = useSyncExternalStore(
    doc.statusFeed.subscribe,
    doc.statusFeed.getSnapshot,
  );
  return <span className={status}>{status}</span>;
}

// Save state indicator
function SaveIndicator({ doc }) {
  const saveState = useSyncExternalStore(
    doc.saveStateFeed.subscribe,
    doc.saveStateFeed.getSnapshot,
  );
  return <span>{saveState}</span>;
}
```

Available Feeds:

| Feed                | Type                        | Changes when                              |
| ------------------- | --------------------------- | ----------------------------------------- |
| `doc.statusFeed`    | `Feed<DocStatus>`           | Connectivity changes                      |
| `doc.saveStateFeed` | `Feed<SaveState>`           | Publish starts/completes, content dirtied |
| `doc.tipFeed`       | `Feed<VersionInfo \| null>` | New snapshot applied                      |
| `doc.loadingFeed`   | `Feed<LoadingState>`        | IPNS resolving, block fetching            |

Each Feed has an equality gate that prevents spurious
notifications — high-frequency events like GossipSub
awareness messages don't trigger re-renders on
unrelated Feeds.

`Feed<T>` interface:

```ts
interface Feed<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): () => void;
}
```

No wrapper hook needed. The interface is designed to
match `useSyncExternalStore` exactly.

### 9. Node diagnostics and topology

`doc.diagnostics()` returns detailed network info
including discovered nodes with their roles:

```ts
const info = doc.diagnostics();

// info.nodes: NodeInfo[]
// Each node has:
//   peerId, short, connected, roles, rolesConfirmed,
//   ackedCurrentCid, lastSeenAt, neighbors,
//   browserCount

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

**Topology graph** — `doc.topologyGraph()` returns a
`TopologyGraph` with `nodes` and `edges` suitable for
rendering a network visualization:

```ts
const topo = doc.topologyGraph();

// topo.nodes: TopologyNode[]
//   id, kind ("self" | "relay" | "pinner" |
//     "relay+pinner" | "browser"),
//   label, connected, roles, clientId?,
//   ackedCurrentCid?, browserCount?

// topo.edges: TopologyGraphEdge[]
//   source, target, connected
```

The graph merges local diagnostics, node-registry data,
and awareness state from remote peers, giving a
whole-network view even of nodes not directly connected
to you.

### 10. Auto-save

The `createAutoSaver` utility handles snapshot publishing
automatically on visibility change, beforeunload, and
debounced `publish-needed` events:

```ts
import { createAutoSaver } from "@pokapali/core";

// Returns a cleanup function
const cleanup = createAutoSaver(doc);

// In React:
useEffect(() => createAutoSaver(doc), [doc]);
```

### 11. Cleanup

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
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

function Editor({ doc }) {
  const ydoc = doc.channel("content");

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
        user: {
          name: "Alice",
          color: "#f44336",
        },
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
import { pokapali } from "@pokapali/core";

const app = pokapali({
  appId: "notes",
  channels: ["content"],
  origin: window.location.origin,
});

const doc = await app.create();
const ydoc = doc.channel("content");
const ytext = ydoc.getText("body");

// Write
ytext.insert(0, "Hello!");

// Observe remote changes
ytext.observe((event) => {
  console.log("Text changed:", ytext.toString());
});

// Persist
doc.on("publish-needed", () => {
  doc.publish();
});

// Share the admin URL
console.log("Share this link:", doc.urls.admin);
```

## URL Routing

Document URLs look like:

```
https://example.com/doc/<ipns-name>#<encoded-keys>
```

The hash fragment contains encrypted capability keys.
The exact URL pattern depends on your app's `origin`
path. Here's one approach to detecting doc URLs:

```ts
// Adapt this to your app's origin path and routing
const BASE = "/my-app";

function isDocUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname.startsWith(BASE + "/doc/") && parsed.hash.length > 1;
}

// Auto-open on page load
if (isDocUrl(window.location.href)) {
  const doc = await app.open(window.location.href);
}
```

## Document Rotation

Admins can rotate a document's identity — generating
new keys, a new IPNS name, and new URLs while
preserving the current content:

```ts
const result = await doc.rotate();
// result.doc — new Doc with fresh keys
// result.forwardingRecord — signed redirect from
//   old IPNS name to new one
```

**What `rotate()` does:**

1. Generates a new `adminSecret` and derives all new
   keys (IPNS keypair, read key, channel access keys)
2. Copies current document state to the new identity
3. Creates new admin/write/read URLs
4. Stores a `rotationKey`-signed forwarding record so
   peers following the old IPNS name discover the new
   location

**When to use it:**

- **Revoking access** — after removing a collaborator,
  rotate so the old URLs stop working
- **Recovering from a compromised `ipnsKey`** — if an
  attacker can publish to the IPNS name, rotating
  gives you a clean identity
- **Seq freeze recovery** — if an attacker publishes
  `seq = 2^64 - 1` to freeze the IPNS pointer,
  rotation is the only recovery path

**Requirements:** Admin capability (has `rotationKey`).
The old document continues to exist — rotation creates
a new identity, it doesn't delete the old one.

## Loading State Machine

`doc.loadingFeed` (or `doc.on("loading", ...)`) reports
the snapshot fetch lifecycle as a discriminated union:

```
  ┌──────────────────────────────────────────┐
  │                                          │
  ▼                                          │
idle ──→ resolving ──→ fetching ──→ idle     │
                          │                  │
                          ▼                  │
                       retrying ─────────────┘
                          │
                          ▼
                       failed
```

| State       | Fields                          | Entered when                                             |
| ----------- | ------------------------------- | -------------------------------------------------------- |
| `idle`      | —                               | Snapshot applied, or new doc with no remote state        |
| `resolving` | `startedAt`                     | IPNS poll begins (readers on `open()`)                   |
| `fetching`  | `cid`, `startedAt`              | CID received from announcement or IPNS resolve           |
| `retrying`  | `cid`, `attempt`, `nextRetryAt` | Block fetch failed; re-triggered on next discovery event |
| `failed`    | `cid`, `error`                  | Fetch exhausted (no more discovery events)               |

Writers skip `resolving` — they receive snapshots via
GossipSub announcements, which provide the CID
directly. Readers start with IPNS resolution.

Retries are event-driven: a failed fetch is retried
when the CID is re-discovered via GossipSub re-announce
(15s) or IPNS poll (30s). There is no fixed retry
count or interval.

On `failed`, the library calls `markReady()` so the
editor mounts with whatever state is available (local
IndexedDB or partial sync) rather than blocking
forever.

## Version History

Pokapali tracks a chain of snapshots — each publish
creates a new version linked to the previous one. You
can browse past versions and load any snapshot as an
independent set of `Y.Doc`s.

### Current tip

```ts
doc.tipCid; // CID | null
```

The CID of the most recently published snapshot, or
`null` if the document has never been published. Useful
for highlighting "you are here" in a version list.

### Listing versions

**Recommended — `versionHistory()`:**

```ts
const versions = await doc.versionHistory();
// Array<{ cid: CID; seq: number; ts: number }>
```

Returns versions **newest-first**. Automatically queries
connected pinners' HTTP history endpoints, falling back
to a local chain walk if no pinners are reachable. This
is the best way to get a complete version list —
pinners track every snapshot they've seen, so the list
isn't truncated by missing intermediate blocks.

**Low-level — `history()`:**

```ts
const versions = await doc.history();
// Array<{ cid: CID; seq: number; ts: number }>
```

Walks the local snapshot chain from the current tip.
Uses a three-tier block resolution strategy:

1. **In-memory cache** — blocks from locally-pushed
   snapshots
2. **Helia blockstore** — blocks from GossipSub or
   prior fetches (5s timeout)
3. **HTTP fallback** — fetches from pinner/relay
   `httpUrl` endpoints, verifying the response hash
   against the requested CID

If a block is still missing after all three tiers,
the walk stops gracefully — the returned list may be
shorter than the full chain but never throws.

Each entry contains:

| Field | Type     | Description                       |
| ----- | -------- | --------------------------------- |
| `cid` | `CID`    | Content-addressed block ID        |
| `seq` | `number` | Yjs clock sum at time of snapshot |
| `ts`  | `number` | Unix timestamp (ms)               |

### Snapshot event

```ts
doc.on("snapshot", (info) => {
  // info.cid     — CID of the snapshot
  // info.seq     — Yjs clock sum
  // info.ts      — Unix timestamp (ms)
  // info.isLocal — true if published by this client
});
```

Fires on both local publishes and remote snapshot
application.

### Loading a version

```ts
const channels = await doc.loadVersion(versions[0].cid);
// Record<string, Y.Doc> — one Y.Doc per channel
```

Returns an independent `Y.Doc` for each channel,
containing the full state at that snapshot. These are
copies — modifying them does not affect the live
document.

### Restoring a version

Restore creates a **new version** — it does not revert
or discard later versions. The snapshot chain is
append-only (CIDs are content hashes), so history is
immutable.

The restore strategy depends on your content type and
editor. Core provides `loadVersion()` as the primitive;
your app applies the old content as new CRDT operations.

**Tiptap / ProseMirror (XmlFragment):**

```ts
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";

async function restoreVersion(doc, editor, cid) {
  const old = await doc.loadVersion(cid);
  const frag = old["content"].getXmlFragment("default");
  const json = yXmlFragmentToProsemirrorJSON(frag);
  editor.commands.setContent(json);
  await doc.publish();
}
```

`setContent()` is a single ProseMirror transaction —
atomic replace with no intermediate empty state.
Yjs translates it into new delete+insert operations
that propagate correctly to all peers.

**Plain Y.Text:**

```ts
async function restoreVersion(doc, cid) {
  const old = await doc.loadVersion(cid);
  const oldText = old["content"].getText("main").toString();
  const current = doc.channel("content").getText("main");
  current.delete(0, current.length);
  current.insert(0, oldText);
  await doc.publish();
}
```

**Why not `Y.applyUpdate()`?** Applying an old Yjs
state update to the current doc _merges_ rather than
_replaces_ — the old state is a subset of the current
state, so it's a no-op or creates merge artifacts.
You must read old content and write it as new CRDT
operations.

## Tips

- **Multiple channels** let you separate concerns
  (e.g. `["text", "metadata"]`) with independent
  write permissions per channel.
- **`publish-needed`** fires when local changes
  are significant enough to warrant persisting. Hook
  it up to `publish()` with a debounce.
- **Capability URLs are secrets** — treat them like
  passwords. The hash fragment is never sent to
  servers, but anyone with the full URL has access.
- **Pokapali nodes** (relays and pinners) are optional.
  Peers connect directly via WebRTC. Relays improve
  discovery and provide GossipSub signaling for peers
  behind NAT. Pinners persist snapshots so documents
  load even when the author is offline.
- **Monitor node health** with
  `doc.diagnostics().nodes` to warn users when no
  pinners are connected.
- **Large documents** (over 1 MB serialized) require at
  least one pinner with HTTP block upload support. The
  library handles this automatically — blocks that
  exceed the 1 MB GossipSub inline limit are uploaded
  via HTTP POST and fetched via HTTP GET.
- **Topology visualization** — use `doc.topologyGraph()`
  combined with the network events (`snapshot`, `ack`,
  `loading`, `gossip-activity`, `guarantee-query`) to
  build a live network map showing data flow between
  your app and infrastructure nodes.
