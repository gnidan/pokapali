# Building an App with Pokapali

Pokapali is a P2P collaborative document library built on
[Yjs](https://yjs.dev), WebRTC, and IPFS
([Helia](https://helia.io), a JS IPFS implementation). It
handles encryption, peer discovery, real-time sync, and
persistent snapshots so you can focus on your app.

This guide has two parts:

1. **[Tutorial](#quick-start)** — step-by-step walkthrough
   from `npm install` to a working collaborative app
2. **[Patterns & Reference](#url-routing)** — standalone
   topics (URL routing, rotation, loading states, version
   history) to consult as needed

---

## Quick Start

```sh
npm install @pokapali/core yjs
```

> **Peer dependency:** `yjs` must be installed
> alongside `@pokapali/core`. If your package manager
> doesn't auto-install peer dependencies, add it
> explicitly.

> **TypeScript note:** if your `tsconfig.json` targets
> ES2022 or earlier, add `"skipLibCheck": true` to
> `compilerOptions`. A transitive dependency uses
> ES2024 types that would otherwise cause build errors.

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

| Option           | Type       | Required | Default         | Description                                                                                                                                                                                                                                                                |
| ---------------- | ---------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`          | `string`   | No       | `""`            | App identifier used for relay discovery, [GossipSub](https://docs.libp2p.io/concepts/pubsub/overview/) (pub/sub messaging) topic namespacing, and HKDF key derivation. Public — not a secret. Different apps with the same `appId` share pinners and relay infrastructure. |
| `channels`       | `string[]` | **Yes**  | —               | Named data channels. Each becomes its own `Y.Doc` with independent write access. E.g. `["content"]`, `["text", "comments"]`.                                                                                                                                               |
| `primaryChannel` | `string`   | No       | `channels[0]`   | Which channel gates `_meta` room access. Peers who can write to the primary channel can modify access allowlists. Usually the main content channel.                                                                                                                        |
| `origin`         | `string`   | **Yes**  | —               | Origin + path prefix for generating shareable URLs (e.g. `window.location.origin` or `"https://example.com/app"`).                                                                                                                                                         |
| `rtc`            | `object`   | No       | —               | WebRTC peer connection options passed to `simple-peer` (e.g. custom ICE servers).                                                                                                                                                                                          |
| `signalingUrls`  | `string[]` | No       | `[]`            | Additional WebSocket signaling server URLs. Empty by default — signaling uses GossipSub via libp2p, not WebSocket servers.                                                                                                                                                 |
| `bootstrapPeers` | `string[]` | No       | libp2p defaults | Override libp2p bootstrap peer multiaddrs. Rarely needed — the defaults connect to the public libp2p network.                                                                                                                                                              |
| `persistence`    | `boolean`  | No       | `true`          | Enable IndexedDB persistence for Yjs state and IPFS blocks. Set to `false` for non-browser environments or testing (see below).                                                                                                                                            |

**`persistence: false`** — Required when IndexedDB is
unavailable (Node.js, SSR, test runners like Vitest with
jsdom). Without it, pokapali attempts to open IndexedDB
on startup and throws. Documents with persistence
disabled keep all state in memory — data is lost when the
page reloads or the process exits. Use `doc.publish()` to
persist snapshots to pinners instead.

**`origin` in non-browser environments** — In a browser
you typically pass `window.location.origin`. In tests,
SSR, or any context where `window` is unavailable, pass
your app's deployment URL as a string:

```ts
const app = pokapali({
  appId: "my-app",
  channels: ["content"],
  origin: "https://my-app.example.com",
  persistence: false,
});
```

The `origin` value is only used to construct capability
URLs (for `doc.urls` and `doc.invite()`). It does not
need to resolve — the generated URLs will work as long
as the origin matches what your frontend serves.

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
doc.urls.best; // highest-privilege URL available
```

`doc.urls.best` returns the highest-privilege URL the
current capability allows: admin if available,
otherwise write, otherwise read. Use it for shareable
links or URL bar updates where you want to preserve
the user's full access level.

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

### 6. Identity and publisher authorization

Every device automatically gets an Ed25519 identity
keypair, scoped per `appId`. No configuration needed —
identity is a built-in property of being a peer.

```ts
// Your device's identity public key (hex)
doc.identityPubkey; // string | null
```

**Publisher attribution:** Every snapshot includes the
publisher's identity public key and signature. This is
always present — you can see who published each version
without enabling any authorization.

**Participant awareness:** All connected peers
broadcast their identity via the awareness protocol.
Access current participants:

```ts
const participants = doc.participants;
// ReadonlyMap<number, ParticipantInfo>
// clientId → { pubkey: string, displayName?: string }

for (const [clientId, info] of participants) {
  console.log(info.pubkey, info.displayName);
}
```

Apps can set a display name via awareness before
opening or creating a doc:

```ts
doc.awareness.setLocalStateField("user", {
  name: "Alice",
});
```

The `displayName` in `ParticipantInfo` is automatically
synced from the awareness `user.name` field — set
`user.name` via awareness and it propagates to
`ParticipantInfo` for all peers. Unsigned, for display
only.

**Client identity mapping:** The `doc.clientIdMapping`
Feed provides a reactive mapping from Yjs clientIDs
to verified identity info. This is useful for
attributing edits and comments to specific users:

```ts
// Feed<ReadonlyMap<number, ClientIdentityInfo>>
const mapping = doc.clientIdMapping.getSnapshot();

for (const [clientId, info] of mapping) {
  // info.pubkey — hex-encoded Ed25519 public key
  // info.verified — signature verified
  console.log(clientId, info.pubkey, info.verified);
}

// Subscribe to changes (e.g. new peers joining)
doc.clientIdMapping.subscribe(() => {
  const updated = doc.clientIdMapping.getSnapshot();
  // rebuild UI...
});
```

Pass this feed to `@pokapali/comments` for author
verification:

```ts
import { comments } from "@pokapali/comments";

const c = comments(commentsDoc, contentDoc, {
  author: doc.identityPubkey,
  clientIdMapping: doc.clientIdMapping,
});
```

#### Permissionless vs authorized mode

By default, documents are **permissionless** — anyone
with write access can publish snapshots. Publisher
attribution is informational only.

Admins can enable **authorized mode** by adding
identity public keys to the publisher allowlist:

```ts
// Enable authorization (admin only)
doc.authorize(alicePubkey);
doc.authorize(bobPubkey);

// Revoke a publisher
doc.deauthorize(bobPubkey);

// Check current allowlist
doc.authorizedPublishers;
// ReadonlySet<string> (hex pubkeys)
```

Once `authorizedPublishers` is non-empty, readers
reject snapshots from unlisted publishers. Snapshots
from before auth was enabled (no publisher field) are
also rejected.

**Key points:**

- `authorize()` / `deauthorize()` require admin
  capability — non-admins get an error
- Auth changes propagate via Yjs sync (eventually
  consistent across peers)
- The doc creator's identity is **not** auto-added —
  the admin explicitly chooses when to enable auth
  and who to authorize
- Pinners store all snapshots regardless (they can't
  decrypt `_meta` to check authorization). Enforcement
  is reader-side only.

### 7. Persistence with snapshots

Pokapali persists document state to IPFS as encrypted
snapshots, published via IPNS. This means a document can
be loaded even when the original author is offline.

```ts
// Publish current state
await doc.publish();

// Auto-save handles publishing on visibility change,
// beforeunload, and debounced dirty state:
import { createAutoSaver } from "@pokapali/core";
const cleanup = createAutoSaver(doc);

// Listen for snapshots (local publishes + remote)
// via the snapshotEvents Feed:
doc.snapshotEvents.subscribe(() => {
  const evt = doc.snapshotEvents.getSnapshot();
  if (!evt) return;
  const { cid, seq, ts, isLocal } = evt;
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

### 8. Document status

Pokapali separates connectivity from persistence:

**Startup behavior:** `create()` and `open()` return
immediately with a Doc in `"connecting"` status. The
P2P layer (Helia, WebRTC, GossipSub) bootstraps in
the background. Local content from IndexedDB is
available right away — the editor can mount and accept
input before any network connection is established.
Use `doc.ready()` to wait for the first remote state
if you need it. Pass `{ timeoutMs }` to reject with a
`TimeoutError` if initial sync takes too long:

```ts
await doc.ready({ timeoutMs: 60_000 });
```

Without a timeout, `ready()` waits indefinitely — if
no pinner or peers are reachable, it never resolves.
See [integration-guide.md](integration-guide.md) for
the full ready() pattern.

**Connectivity** — `doc.status` tells you whether the
document is connected to peers:

```ts
// Current value
doc.status.getSnapshot();
// "connecting" | "synced" | "receiving" | "offline"

// Subscribe to changes
doc.status.subscribe(() => {
  const status = doc.status.getSnapshot();
  // "synced"     — connected, can send and receive
  // "receiving"  — connected read-only (no write cap)
  // "connecting" — establishing peer connections
  // "offline"    — no peers reachable
});
```

**Persistence** — `doc.saveState` tells you whether
local changes have been published to IPFS:

```ts
// Current value
doc.saveState.getSnapshot();
// "saved" | "dirty" | "saving" | "unpublished"

// Subscribe to changes
doc.saveState.subscribe(() => {
  const state = doc.saveState.getSnapshot();
  // "saved"       — snapshot published and acked
  // "dirty"       — local changes not yet published
  // "saving"      — snapshot push in progress
  // "unpublished" — new doc, never published
});
```

**Backup status** — `doc.backedUp` tells you whether
at least one pinner has acknowledged the current tip:

```ts
doc.backedUp.subscribe(() => {
  const safe = doc.backedUp.getSnapshot();
  if (!safe) console.warn("No pinner ack yet");
});
```

**Loading progress:**

```ts
doc.loading.subscribe(() => {
  const state = doc.loading.getSnapshot();
  // state.status: "idle" | "resolving" |
  //   "fetching" | "retrying" | "failed"
});
```

### 9. Reactive Feeds

For framework integration (especially React), each
status property has a corresponding `Feed<T>` that
works directly with `useSyncExternalStore`:

```ts
import { useSyncExternalStore } from "react";

// Status indicator
function StatusBadge({ doc }) {
  const status = useSyncExternalStore(
    doc.status.subscribe,
    doc.status.getSnapshot,
  );
  return <span className={status}>{status}</span>;
}

// Save state indicator
function SaveIndicator({ doc }) {
  const saveState = useSyncExternalStore(
    doc.saveState.subscribe,
    doc.saveState.getSnapshot,
  );
  return <span>{saveState}</span>;
}
```

Available Feeds:

| Feed                       | Type                                            | Changes when                                |
| -------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `doc.status`               | `Feed<DocStatus>`                               | Connectivity changes                        |
| `doc.saveState`            | `Feed<SaveState>`                               | Publish starts/completes, content dirtied   |
| `doc.tip`                  | `Feed<VersionInfo \| null>`                     | New snapshot applied                        |
| `doc.loading`              | `Feed<LoadingState>`                            | IPNS resolving, block fetching              |
| `doc.backedUp`             | `Feed<boolean>`                                 | Pinner ack received or tip changes          |
| `doc.versions`             | `Feed<VersionHistory>`                          | Chain walk progress, new snapshots          |
| `doc.snapshotEvents`       | `Feed<SnapshotEvent \| null>`                   | Every local publish or remote snapshot      |
| `doc.gossipActivity`       | `Feed<GossipActivity>`                          | GossipSub message received                  |
| `doc.clientIdMapping`      | `Feed<ReadonlyMap<number, ClientIdentityInfo>>` | Peer registers identity in \_meta           |
| `doc.lastPersistenceError` | `Feed<string \| null>`                          | IDB write fails or recovers                 |
| `doc.lastValidationError`  | `Feed<{cid: string, message: string} \| null>`  | Remote snapshot fails structural validation |

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

**Vanilla JavaScript:**

Feeds work without React or any framework. Call
`subscribe` to listen for changes and `getSnapshot`
to read the current value:

```ts
// Subscribe to a single feed
const unsub = doc.status.subscribe(() => {
  const status = doc.status.getSnapshot();
  statusEl.textContent = status;
});

// Read the current value at any time
console.log("Status:", doc.status.getSnapshot());

// Unsubscribe when done
unsub();
```

**Updating the DOM:**

```ts
function bindFeed<T>(
  feed: Feed<T>,
  el: HTMLElement,
  render: (value: T) => string,
): () => void {
  const update = () => {
    el.textContent = render(feed.getSnapshot());
  };
  update(); // initial render
  return feed.subscribe(update);
}

// Usage
const unsub = bindFeed(
  doc.saveState,
  document.getElementById("save-indicator")!,
  (state) => {
    switch (state) {
      case "saved":
        return "All changes saved";
      case "dirty":
        return "Unsaved changes";
      case "saving":
        return "Saving…";
      case "unpublished":
        return "Not yet published";
    }
  },
);
```

**Combining multiple feeds:**

```ts
// Watch several feeds, update when any changes
function watchFeeds(feeds: Feed<unknown>[], cb: () => void): () => void {
  const unsubs = feeds.map((f) => f.subscribe(cb));
  return () => unsubs.forEach((u) => u());
}

const unsub = watchFeeds([doc.status, doc.saveState, doc.backedUp], () => {
  const status = doc.status.getSnapshot();
  const save = doc.saveState.getSnapshot();
  const backed = doc.backedUp.getSnapshot();
  console.log(`${status} | ${save} | ` + `backed up: ${backed}`);
});
```

**Waiting for a specific value:**

```ts
function waitFor<T>(
  feed: Feed<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const current = feed.getSnapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsub = feed.subscribe(() => {
      const value = feed.getSnapshot();
      if (predicate(value)) {
        unsub();
        resolve(value);
      }
    });
  });
}

// Wait until connected
await waitFor(doc.status, (s) => s === "synced");
```

**Persistence errors:**

`doc.lastPersistenceError` reports IndexedDB write
failures — typically quota exceeded in incognito mode
or private browsing. It's `null` when healthy and
resets to `null` when writes recover:

```ts
function PersistenceWarning({ doc }) {
  const err = useSyncExternalStore(
    doc.lastPersistenceError.subscribe,
    doc.lastPersistenceError.getSnapshot,
  );
  if (!err) return null;
  return (
    <div className="warning">
      Local storage error: {err}. Changes sync to
      peers but won't survive a page reload.
    </div>
  );
}
```

This Feed is experimental — see `api-stability.md`.

**Version history Feed:**

`doc.versions` provides reactive version history that
updates as the chain walk progresses:

```ts
function VersionList({ doc }) {
  const { entries, walking } = useSyncExternalStore(
    doc.versions.subscribe,
    doc.versions.getSnapshot,
  );

  return (
    <ul>
      {entries.map((v) => (
        <li key={v.cid.toString()}>
          v{v.seq} — {v.status}
        </li>
      ))}
      {walking && <li>Loading older versions…</li>}
    </ul>
  );
}
```

Each `VersionHistoryEntry` has:

| Field    | Type                                   | Description              |
| -------- | -------------------------------------- | ------------------------ |
| `cid`    | `CID`                                  | Content-addressed block  |
| `seq`    | `number`                               | Snapshot sequence number |
| `ts`     | `number`                               | Unix timestamp (ms)      |
| `status` | `"available" \| "loading" \| "failed"` | Block fetch status       |

The `walking` flag is `true` while the chain walk is
in progress (entries with pending block fetches). Use
it to show a loading indicator.

### 10. Node diagnostics and topology

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

// topo.edges: TopologyEdge[]
//   source, target, connected
```

The graph merges local diagnostics, node-registry data,
and awareness state from remote peers, giving a
whole-network view even of nodes not directly connected
to you.

### 11. Auto-save

The `createAutoSaver` utility handles snapshot publishing
automatically on visibility change, beforeunload, and
debounced `publish-needed` events. **Browser only** —
it uses `window.addEventListener("beforeunload")` and
`document.addEventListener("visibilitychange")`. For
non-browser environments, call `doc.publish()` directly.

```ts
import { createAutoSaver } from "@pokapali/core";

// Returns a cleanup function
const cleanup = createAutoSaver(doc);

// In React:
useEffect(() => createAutoSaver(doc), [doc]);
```

### 12. Cleanup

Always destroy when done to release WebRTC connections,
awareness rooms, and the shared Helia instance:

```ts
doc.destroy();
```

### 13. Bundle optimization

`@pokapali/core` includes libp2p, Helia, and crypto
libraries (~2 MB). Use dynamic imports to keep your
initial bundle small:

```ts
// Lazy-load core — only fetched when needed
const { pokapali } = await import("@pokapali/core");
const app = pokapali({ ... });
```

For React apps, combine with `React.lazy` to split
the editor into a separate chunk:

```tsx
import { lazy, Suspense } from "react";

const Editor = lazy(() => import("./Editor"));

function App() {
  const [doc, setDoc] = useState(null);

  // Load core + create doc on demand
  useEffect(() => {
    import("@pokapali/core").then(({ pokapali }) => {
      const app = pokapali({ ... });
      app.create().then(setDoc);
    });
  }, []);

  if (!doc) return <div>Loading...</div>;
  return (
    <Suspense fallback={<div>Loading editor...</div>}>
      <Editor doc={doc} />
    </Suspense>
  );
}
```

**Vite manual chunks:** Split P2P and editor vendor
dependencies into separate chunks so they cache
independently:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          p2p: ["@pokapali/core", "libp2p", "@helia/interface"],
          editor: ["@tiptap/react", "@tiptap/starter-kit", "prosemirror-state"],
        },
      },
    },
  },
});
```

This reduces initial page load to a few KB — the P2P
and editor chunks load in parallel when the user
navigates to a document.

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
        provider: { awareness: doc.awareness },
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

// Auto-persist on changes, visibility, beforeunload
import { createAutoSaver } from "@pokapali/core";
createAutoSaver(doc);

// Share the admin URL
console.log("Share this link:", doc.urls.admin);
```

---

# Patterns & Reference

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
// result.newDoc — new Doc with fresh keys
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

`doc.loading` Feed reports
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

Retries use exponential backoff: up to 3 attempts with
delays of 10 s, 30 s, 90 s (`RETRY_BASE_MS * 3^(n-1)`).
A failed fetch can also be retried earlier when the CID
is re-discovered via GossipSub re-announce (15 s) or
IPNS poll (30 s).

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
const tip = doc.tip.getSnapshot();
tip?.cid; // CID | null
tip?.seq; // sequence number
tip?.ackedBy; // ReadonlySet<string> — pinner peer IDs
```

The tip Feed reflects the most recently published
snapshot. `null` if the document has never been
published. Useful for highlighting "you are here" in
a version list and for checking pinner acknowledgment.

### Listing versions

**Recommended — `doc.versions` Feed:**

The `doc.versions` Feed (see section 9) provides
reactive version history that updates automatically as
snapshots are discovered and chain-walked. This is the
primary API for version listing.

**`versionHistory()` (async, one-shot):**

```ts
const versions = await doc.versionHistory();
// Array<{ cid: CID; seq: number; ts: number }>
```

Returns versions **newest-first**. Queries connected
pinners' HTTP history endpoints, falling back to a
local chain walk if no pinners are reachable.

### Snapshot events

The `doc.snapshotEvents` Feed fires on every local
publish and remote snapshot application:

```ts
doc.snapshotEvents.subscribe(() => {
  const evt = doc.snapshotEvents.getSnapshot();
  if (!evt) return;
  // evt.cid     — CID of the snapshot
  // evt.seq     — Yjs clock sum
  // evt.ts      — Unix timestamp (ms)
  // evt.isLocal — true if published by this client
});
```

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
- **`createAutoSaver(doc)`** handles publishing on
  dirty state, visibility change, and beforeunload.
  Prefer this over manual `publish()` calls.
- **Capability URLs are secrets** — treat them like
  passwords. The hash fragment is never sent to
  servers, but anyone with the full URL has access.
- **Infrastructure model:**
  - **Relays are shared** — all apps discover peers
    through the same relay network. Peers connect
    directly via WebRTC; relays improve discovery and
    provide GossipSub signaling for peers behind NAT.
  - **Pinners are per-app** — a pinner only stores
    snapshots for the `appId`s it's configured to
    serve. The existing pokapali pinners serve the
    example app. **If you're building a new app, you
    need to run your own pinner** — otherwise your
    data won't persist when all browsers close.
  - **Anyone can run a pinner.** That's the community
    model: app developers run the initial pinners for
    their app. Users who care about persistence can
    run additional pinners. A pinner can serve
    multiple apps.
  - **Zero-knowledge** — pinners store encrypted
    blocks they cannot read. Running a pinner does
    not grant access to document content.
- **Running a pinner** — pinners subscribe to
  GossipSub topics scoped by `appId`. Pass your
  app's ID to the `--pin` flag:
  ```sh
  npx @pokapali/node --relay --pin "my-app"
  ```
  Multiple apps: `--pin "app1,app2"`. The pinner
  only stores snapshots for the listed app IDs.
  Your app's `appId` must match exactly.
- **Monitor pinner health** with
  `doc.diagnostics().nodes` to warn users when no
  pinners are connected. Use `doc.backedUp` to
  show whether at least one pinner has acknowledged
  the current snapshot.
- **Large documents** (over 1 MB serialized) require at
  least one pinner with HTTP block upload support. The
  library handles this automatically — blocks that
  exceed the 1 MB GossipSub inline limit are uploaded
  via HTTP POST and fetched via HTTP GET.
- **Topology visualization** — use `doc.topologyGraph()`
  combined with Feed subscriptions (`snapshotEvents`,
  `backedUp`, `loading`, `gossipActivity`) to build a
  live network map showing data flow between your app
  and infrastructure nodes.

---

## Next steps

- **[Integration Guide](integration-guide.md)** —
  add pokapali to an existing Tiptap or ProseMirror
  editor
