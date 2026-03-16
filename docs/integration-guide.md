# Integration Guide: Adding Pokapali to an Existing Editor

This guide walks through adding real-time collaboration
and encrypted persistence to an existing Tiptap or
ProseMirror editor. It covers the full integration
surface — not just wiring, but the subtle details that
make the difference between a working demo and a
coherent user experience.

> **Audience:** A developer who has a working Tiptap
> editor and wants to add collaboration. Familiarity
> with Yjs is helpful but not required.

---

## Install

```bash
npm install @pokapali/core yjs y-protocols
```

`@pokapali/core` transitively pulls in crypto,
capability, subdocs, snapshot, sync, and log packages
plus helia, libp2p, and y-webrtc. You don't need to
install those directly.

For Tiptap collaboration extensions (if not already
installed):

```bash
npm install @tiptap/extension-collaboration \
  @tiptap/extension-collaboration-cursor
```

For React helpers (optional but recommended):

```bash
npm install @pokapali/react
```

---

## Initialize

Call `pokapali()` once at module scope. This creates
the app instance that manages Helia, libp2p, and
GossipSub. Do not create multiple instances.

```ts
import { pokapali } from "@pokapali/core";

const app = pokapali({
  appId: "your-app-id",
  channels: ["content"],
  origin: window.location.origin,
});
```

### `appId`

A public string — not a secret. It scopes:

- **Key derivation** — different `appId` = different
  encryption keys from the same admin secret
- **IDB storage** — each `appId` gets its own
  blockstore (`pokapali:blocks:${appId}`)
- **GossipSub topics** — pinners subscribe per-app
- **Relay discovery** — peers find each other within
  the same `appId` namespace

Use a globally unique string. A reverse-domain
identifier works well:
`"github.com/yourname/your-editor"`.

**Gotcha:** Two apps with the same `appId` see each
other's relay traffic and pinner announcements. Use
distinct IDs for distinct apps.

### `channels`

The list of named Yjs subdocuments your app uses.
Each channel is a separate `Y.Doc` with its own
WebRTC room and encryption key.

For a simple editor, `["content"]` is sufficient.
For an editor with comments:
`["content", "comments"]`.

The channel list is fixed at init time. All channels
are created eagerly — including WebRTC rooms.

### `origin`

The base URL for generated capability links
(`doc.urls.admin`, `.write`, `.read`). Usually
`window.location.origin` or
`window.location.origin + "/app"` if your editor
lives at a subpath.

### Other options

```ts
pokapali({
  // ...required options above

  persistence: true, // IDB for Yjs state + blocks
  // (default: true)

  // Optional: custom bootstrap peers for DHT entry
  // bootstrapPeers: ["/dns4/..."],

  // Optional: WebRTC ICE servers
  // rtc: { config: { iceServers: [...] } },
});
```

---

## Create or Open a Document

```ts
// Create a new document
const doc = await app.create();

// Open an existing document from a capability URL
const doc = await app.open(url);
```

Both return a `Doc` instance. The difference: `create`
generates a new admin secret and derives all keys;
`open` parses keys from the URL fragment.

### URL Routing

Detect whether the current page URL is a document URL:

```ts
if (app.isDocUrl(window.location.href)) {
  const doc = await app.open(window.location.href);
  // Update URL without adding history entry
  history.replaceState(null, "", doc.urls.best);
} else {
  // Show landing page / create button
}
```

`doc.urls.best` returns the highest-privilege URL
available to the current capability level.

After creating a document, push the URL:

```ts
const doc = await app.create();
history.pushState(null, "", doc.urls.best);
```

---

## Wire to Tiptap

```ts
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

const editor = new Editor({
  editable: !isReadOnly,
  extensions: [
    StarterKit.configure({ history: false }),
    Collaboration.configure({
      document: doc.channel("content"),
    }),
    CollaborationCursor.configure({
      provider: doc.provider,
      user: { name: "Alice", color: "#2196f3" },
    }),
  ],
});
```

### `history: false` — Critical

You **must** disable Tiptap's built-in undo history.
Yjs manages undo via its own CRDT operations. Running
both causes silent corruption — edits appear to work
but the document state diverges. There is no error
message; the document just breaks.

### Read-Only Detection

```ts
const isReadOnly = !doc.capability.channels.has("content");
```

A peer without the `"content"` channel key can read
(via snapshots) but cannot write. Set
`editable: false` on the editor.

---

## The `ready()` Gate

This is the most important subtlety in the
integration. Getting it wrong causes either a blank
editor (for readers) or content overwrite (for late
joiners).

### The Problem

When a document opens, there may be existing content
on the network (snapshots from pinners, state from
other peers). `doc.ready()` resolves when that initial
state has been loaded. If you mount the editor before
`ready()`, the editor starts with an empty document
and Yjs treats that as the local state — which can
cause the empty state to "win" in a merge for
read-only peers.

### The Rules

- **Writers:** Mount the editor immediately. Writers
  join the WebRTC room and sync state bidirectionally
  — they'll receive content from peers even without
  a snapshot.
- **Readers:** Wait for `ready()` before mounting.
  Readers receive content via snapshots only. Without
  waiting, they see blank content.
- **Fallback timeout:** If no pinner is reachable and
  no peers are online, `ready()` never resolves. Add
  a timeout so readers aren't stuck indefinitely.
  60 seconds is a reasonable default.

### Pattern (with `@pokapali/react`)

```tsx
import { useDocReady } from "@pokapali/react";

const ready = useDocReady(doc, 60_000);
const shouldMount = ready || !isReadOnly;
```

### Pattern (without `@pokapali/react`)

`doc.ready()` accepts an optional `timeoutMs`:

```ts
const [ready, setReady] = useState(false);

useEffect(() => {
  let cancelled = false;
  doc.ready({ timeoutMs: 60_000 }).then(
    () => {
      if (!cancelled) setReady(true);
    },
    () => {
      // Timed out — mount anyway
      if (!cancelled) setReady(true);
    },
  );
  return () => {
    cancelled = true;
  };
}, [doc]);

const shouldMount = ready || !isReadOnly;
```

---

## Auto-Save

```ts
import { createAutoSaver } from "@pokapali/core";

const cleanup = createAutoSaver(doc);
// Call cleanup() on unmount
```

`createAutoSaver` handles:

- Debounced `publish()` on content changes
  (5 second default, configurable via
  `{ debounceMs }`)
- `beforeunload` handler — prompts "leave page?" if
  unsaved
- `visibilitychange` handler — fire-and-forget
  publish when tab is hidden

It's a no-op for read-only peers (checks
`canPushSnapshots`).

**This is not optional for writers.** Without it,
edits exist only in memory and the WebRTC room. If
all peers close their tabs, unsaved edits are lost.

### React

```tsx
import { useAutoSave } from "@pokapali/react";

useAutoSave(doc);
```

Or without `@pokapali/react`:

```tsx
useEffect(() => createAutoSaver(doc), [doc]);
```

---

## Status and Save State

### Connectivity: `doc.status`

A `Feed<DocStatus>` with values:

| Value          | Meaning                                  |
| -------------- | ---------------------------------------- |
| `"connecting"` | Joining the network                      |
| `"receiving"`  | Subscribed to GossipSub, not yet in mesh |
| `"synced"`     | In the mesh, actively syncing            |
| `"offline"`    | No relay connections                     |

Human-readable labels:

```ts
import { statusLabel } from "@pokapali/core";

statusLabel("synced"); // "Live"
statusLabel("connecting"); // "Connecting"
```

### Persistence: `doc.saveState`

A `Feed<SaveState>` with values:

| Value           | Meaning                                           |
| --------------- | ------------------------------------------------- |
| `"unpublished"` | No snapshot has ever been pushed for this doc     |
| `"dirty"`       | Local edits exist that haven't been published     |
| `"saving"`      | `publish()` is in progress                        |
| `"saved"`       | Latest edits have been published                  |
| `"save-error"`  | Last `publish()` failed (see `doc.lastSaveError`) |

Human-readable labels:

```ts
import { saveLabel } from "@pokapali/core";

saveLabel("saved"); // "Published"
saveLabel("dirty"); // "Publish changes"
```

**`"unpublished"` is not `"dirty"`.** It means the
document has never had a snapshot — not that the
current edits are unsaved. On a brand-new document,
the state starts as `"unpublished"` until the first
`publish()`.

### Subscribing to Feeds

Feeds implement the `useSyncExternalStore` interface.

With `@pokapali/react` (recommended):

```tsx
import { useFeed } from "@pokapali/react";

function StatusBar({ doc }: { doc: Doc }) {
  const status = useFeed(doc.status);
  const saveState = useFeed(doc.saveState);
  // ...
}
```

Without `@pokapali/react`:

```ts
import { useSyncExternalStore } from "react";
import type { Feed } from "@pokapali/core";

function useFeed<T>(feed: Feed<T>): T {
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}
```

Outside React, use `feed.subscribe()` directly:

```ts
const unsubscribe = doc.status.subscribe(() => {
  console.log("Status:", doc.status.getSnapshot());
});
```

### Pinner Acknowledgments

To show "Saved to N pinners":

```ts
const tip = useFeed(doc.tip);
const ackCount = tip?.ackedBy.size ?? 0;
```

### Backup Status

To show whether the current version is backed up:

```ts
const backedUp = useFeed(doc.backedUp);
// true when current tip has at least one pinner ack
// resets to false on new publish until re-acked
```

---

## Snapshot Events

When a remote snapshot is applied, the
`doc.snapshotEvents` Feed fires:

```ts
const snapshot = useFeed(doc.snapshotEvents);

useEffect(() => {
  if (!snapshot || snapshot.isLocal) return;
  // Flash a "new version received" indicator
}, [snapshot]);
```

Note: `snapshotEvents` fires on every snapshot
(including local publishes with `isLocal: true`).
It never deduplicates — each snapshot is a distinct
event.

---

## Awareness and Cursors

### Setting Local User Info

```ts
doc.awareness.setLocalStateField("user", {
  name: "Alice",
  color: "#2196f3",
});
```

The `{ name, color }` shape is what Tiptap's
`CollaborationCursor` expects. Persist these values
in `localStorage` so they survive page reloads.

### Reading Participants

```ts
// Map<clientId, ParticipantInfo>
const participants = doc.participants;
```

`doc.participants` is not a Feed — subscribe to
awareness changes manually:

```ts
doc.awareness.on("change", () => {
  // Re-read doc.participants
});
```

---

## Sharing and Invites

### Capability URLs

Every document has three capability levels:

```ts
doc.urls.admin; // Full control (derive everything)
doc.urls.write; // Read + write + publish
doc.urls.read; // Read only
```

### Custom Invites

Grant specific channel access:

```ts
// Comment-only reviewer
const url = await doc.invite({
  channels: ["comments"],
  canPushSnapshots: false,
});

// Editor who can also publish snapshots
const url = await doc.invite({
  channels: ["content", "comments"],
  canPushSnapshots: true,
});
```

---

## Cleanup and Lifecycle

### Destroy Ordering — Critical

`doc.destroy()` must be the **last** cleanup to run.
All other cleanups (awareness listeners, auto-save,
editor instance) must complete first. If they run
after `destroy()`, they access a destroyed doc.

With `@pokapali/react`:

```tsx
import { useAutoSave, useDocDestroy } from "@pokapali/react";

// Other hooks first
useAutoSave(doc);

// This MUST be last
useDocDestroy(doc);
```

Without `@pokapali/react`, in React, effect cleanup
runs in declaration order. Declare `doc.destroy()` in
the **last** `useEffect`:

```tsx
// Other effects first
useEffect(() => createAutoSaver(doc), [doc]);

useEffect(() => {
  // awareness listeners, etc.
  return () => {
    /* cleanup */
  };
}, [doc]);

// This MUST be last
useEffect(
  () => () => {
    doc.destroy();
  },
  [doc],
);
```

### Cancelled Opens

If a user navigates away while `app.open()` is in
progress, destroy the doc to avoid leaking resources:

```ts
useEffect(() => {
  let cancelled = false;
  let d: Doc | null = null;

  app.open(url).then((doc) => {
    if (cancelled) {
      doc.destroy();
      return;
    }
    d = doc;
    setDoc(doc);
  });

  return () => {
    cancelled = true;
    d?.destroy();
  };
}, [url]);
```

---

## Comments Integration

### Install

```bash
npm install @pokapali/comments @pokapali/comments-tiptap
```

### Setup

```ts
import { comments } from "@pokapali/comments";
import {
  anchorFromSelection,
  CommentHighlight,
  PendingAnchorHighlight,
  resolveAnchors,
  getSyncState,
} from "@pokapali/comments-tiptap";
```

### Create a Comments Instance

```ts
const commentsDoc = doc.channel("comments");
const contentDoc = doc.channel("content");

const c = comments<MyCommentData>(commentsDoc, contentDoc, {
  author: doc.identityPubkey,
  clientIdMapping: doc.clientIdMapping,
  contentType: contentDoc.getXmlFragment("default"),
});

c.feed; // Feed<Comment<T>[]>
c.add({ content, anchor, data });
c.update(id, { data });
c.delete(id);
c.destroy();
```

Note the `contentType` option — Tiptap uses
`XmlFragment`, not `Text`. Passing the fragment
ensures anchors resolve against the correct Yjs
type.

### Tiptap Extensions

Add the comment highlight extensions to your editor:

```ts
const editor = useEditor({
  extensions: [
    // ...other extensions
    CommentHighlight.configure({
      commentsDoc,
      contentDoc,
      activeCommentId: selectedCommentId,
    }),
    PendingAnchorHighlight,
  ],
});
```

### Creating Anchors

Create an anchor from the current editor selection:

```ts
import { anchorFromSelection } from "@pokapali/comments-tiptap";

const anchor = anchorFromSelection(editor);
if (anchor) {
  c.add({
    content: "My comment",
    anchor,
    data: { status: "open" },
  });
}
```

### Resolving Anchor Positions

Map comment anchors to editor positions (e.g. for
sidebar ordering):

```ts
const syncState = getSyncState(editor);
const anchors = resolveAnchors(commentsDoc, contentDoc, syncState);
// anchors: Array<{ id, from, to }>
```

---

## Error Handling

### Save Errors

```ts
const saveState = useFeed(doc.saveState);
if (saveState === "save-error") {
  console.error(doc.lastSaveError);
}
```

Common causes: no reachable relays (blocks can't be
uploaded), Helia not yet initialized, or transient
network failures. Auto-save retries on the next
content change.

### Channel Access Errors

```ts
try {
  const ydoc = doc.channel("content");
} catch (e) {
  // "Unknown channel: content"
  // The channel wasn't in the channels[] config
}
```

---

## Bundle Size

The full dependency tree adds ~500-600KB min+gzip,
almost entirely from helia + libp2p. Pokapali's own
code is ~30KB; Yjs + y-webrtc + y-indexeddb add ~30KB.

### Mitigation: Code Splitting

Helia is lazy-loaded — it's not imported until
`create()` or `open()` is called. With route-level
code splitting, your landing page stays light and the
IPFS stack loads only when the user opens a document.

```ts
// This import is lightweight (~30KB)
import { pokapali } from "@pokapali/core";

// Helia loads here (~500KB, async)
const doc = await app.create();
```

---

## Full Example: Tiptap + React

```tsx
import { useState, useEffect } from "react";
import { pokapali, statusLabel, saveLabel, type Doc } from "@pokapali/core";
import {
  useFeed,
  useDocReady,
  useAutoSave,
  useDocDestroy,
} from "@pokapali/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

const app = pokapali({
  appId: "my-editor",
  channels: ["content"],
  origin: window.location.origin,
});

function App() {
  const [doc, setDoc] = useState<Doc | null>(null);

  useEffect(() => {
    let cancelled = false;
    let d: Doc | null = null;

    const url = window.location.href;
    const promise = app.isDocUrl(url) ? app.open(url) : app.create();

    promise.then((newDoc) => {
      if (cancelled) {
        newDoc.destroy();
        return;
      }
      d = newDoc;
      history.replaceState(null, "", newDoc.urls.best);
      setDoc(newDoc);
    });

    return () => {
      cancelled = true;
      d?.destroy();
    };
  }, []);

  if (!doc) return <div>Connecting...</div>;
  return <Editor doc={doc} />;
}

function Editor({ doc }: { doc: Doc }) {
  const isReadOnly = !doc.capability.channels.has("content");
  const ready = useDocReady(doc, 60_000);
  const status = useFeed(doc.status);
  const saveState = useFeed(doc.saveState);
  const shouldMount = ready || !isReadOnly;

  useAutoSave(doc);

  const editor = useEditor(
    {
      editable: !isReadOnly,
      extensions: shouldMount
        ? [
            StarterKit.configure({
              history: false,
            }),
            Collaboration.configure({
              document: doc.channel("content"),
            }),
            CollaborationCursor.configure({
              provider: doc.provider,
              user: {
                name: "Alice",
                color: "#2196f3",
              },
            }),
          ]
        : [StarterKit],
    },
    [shouldMount],
  );

  // Must be the last hook
  useDocDestroy(doc);

  if (!shouldMount) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <div>
        {statusLabel(status)} | {saveLabel(saveState)}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
```

---

## Reactive Feeds Reference

All Feeds on `Doc` support `useSyncExternalStore`
(or `useFeed` from `@pokapali/react`):

| Feed                  | Type                                            | Description                       |
| --------------------- | ----------------------------------------------- | --------------------------------- |
| `doc.status`          | `Feed<DocStatus>`                               | Connectivity state                |
| `doc.saveState`       | `Feed<SaveState>`                               | Persistence state                 |
| `doc.tip`             | `Feed<VersionInfo \| null>`                     | Current chain tip + ack/guarantee |
| `doc.loading`         | `Feed<LoadingState>`                            | IPNS/block fetch lifecycle        |
| `doc.backedUp`        | `Feed<boolean>`                                 | True when tip has pinner ack      |
| `doc.versions`        | `Feed<VersionHistory>`                          | Version chain as it's discovered  |
| `doc.snapshotEvents`  | `Feed<SnapshotEvent \| null>`                   | Every snapshot (local and remote) |
| `doc.gossipActivity`  | `Feed<GossipActivity>`                          | GossipSub message flow state      |
| `doc.clientIdMapping` | `Feed<ReadonlyMap<number, ClientIdentityInfo>>` | Verified client→pubkey mapping    |
