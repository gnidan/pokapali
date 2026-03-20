# @pokapali/react

```sh
npm install @pokapali/react
```

React bindings for pokapali — hooks for document
state, ready-made components for threaded comments
with spatial anchoring, and indicator components for
connection status and save state.

## Quick Start

```typescript
import { pokapali } from "@pokapali/core";
import {
  useFeed,
  useDocReady,
  useAutoSave,
  useDocDestroy,
} from "@pokapali/react";

function Editor({ doc }: { doc: Doc }) {
  const ready = useDocReady(doc);
  const status = useFeed(doc.status);
  const saveState = useFeed(doc.saveState);

  useAutoSave(doc);
  useDocDestroy(doc); // must be last hook

  if (!ready) return <p>Loading...</p>;

  return (
    <div>
      <p>Status: {status}</p>
      <p>Save: {saveState}</p>
      {/* wire doc.channel("content") to your editor */}
    </div>
  );
}
```

## Hooks

### Stable

| Hook            | Signature                      | Description                                                                                                                         |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `useFeed`       | `(feed: Feed<T>) => T`         | Subscribe to a reactive Feed via `useSyncExternalStore`. Accepts `null`/`undefined`, returns `undefined` until a feed is available. |
| `useDocReady`   | `(doc, timeoutMs?) => boolean` | Returns `true` once `doc.ready()` resolves. Optional timeout resolves early.                                                        |
| `useDocDestroy` | `(doc) => void`                | Calls `doc.destroy()` on unmount. Declare this hook **last** so React cleans it up first (reverse order).                           |

### Experimental

| Hook               | Signature                                       | Description                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAutoSave`      | `(doc, debounceMs?) => void`                    | Sets up debounced auto-publish. No-op if the doc lacks push capability. Cleans up on unmount.                                                                                               |
| `useParticipants`  | `(doc) => ReadonlyMap<number, ParticipantInfo>` | Subscribe to awareness and return the current participant map. Re-renders on awareness changes.                                                                                             |
| `useSnapshotFlash` | `(doc, durationMs?) => boolean`                 | Returns `true` briefly after a snapshot event, for visual feedback (flash/pulse). Defaults to 2000 ms.                                                                                      |
| `useComments`      | `(doc, options?) => UseCommentsResult`          | Wire `@pokapali/comments` to a Doc. Returns reactive comment list and CRUD actions (`addComment`, `addReply`, `updateComment`, `deleteComment`). Generic over app-defined comment data `T`. |

## Comment Components

Ready-made UI for threaded, anchored comments.
Requires `@pokapali/comments` and a Tiptap editor
with `@pokapali/comments-tiptap` extensions.

### CSS

Import the stylesheet for default comment styles:

```typescript
import "@pokapali/react/comments.css";
```

All classes use BEM with a `pkp-` prefix
(`pkp-comment-sidebar`, `pkp-comment-popover`, etc.).
Override or replace as needed.

### CommentSidebar

Threaded comment list ordered by document position.
Comments with anchors are spatially aligned to their
anchor text when an `editorView` is provided.

```typescript
import {
  CommentSidebar,
  useComments,
} from "@pokapali/react";
import {
  resolveAnchors,
  getSyncState,
} from "@pokapali/comments-tiptap";

const { comments, addComment, addReply, ... } =
  useComments(doc);

<CommentSidebar
  comments={comments}
  anchorPositions={posMap}
  editorView={editor?.view ?? null}
  myPubkey={doc.identityPubkey}
  status={status}
  hasPendingAnchor={!!pendingAnchor}
  onAddComment={(content) =>
    addComment(content, { status: "open" }, anchor)
  }
  onAddReply={(parentId, content) =>
    addReply(parentId, content, { status: "open" })
  }
  onResolve={(id) =>
    updateComment(id, {
      data: { status: "resolved" },
    })
  }
  onReopen={(id) =>
    updateComment(id, { data: { status: "open" } })
  }
  onDelete={deleteComment}
  onClose={() => setSidebarOpen(false)}
  selectedId={activeId}
  onSelect={setActiveId}
/>
```

### CommentPopover

Floating button that appears near a text selection
inside the editor. Monitors selection changes and
handles viewport edge flipping.

```typescript
import { CommentPopover } from "@pokapali/react";

<CommentPopover
  onComment={() => {
    const anchor = anchorFromSelection(editor);
    if (anchor) {
      addComment("", { status: "open" }, anchor);
    }
  }}
  editorSelector=".ProseMirror"
/>
```

### Labels (i18n)

Both components accept an optional `labels` prop
for customizing all user-facing strings. All fields
have English defaults — override only what you need:

```typescript
import type {
  CommentSidebarLabels,
  CommentPopoverLabels,
} from "@pokapali/react";

<CommentSidebar
  labels={{
    title: "Kommentare",
    submitButton: "Senden",
    resolveButton: "Erledigt",
    formatAge: (ts) => myRelativeTime(ts),
    formatAuthor: (pubkey) => lookupName(pubkey),
  }}
  ...
/>
```

Use `defaultSidebarLabels` and `defaultPopoverLabels`
to inspect or spread from the built-in defaults.

### spatialLayout

Utility for resolving overlapping comment cards:

```typescript
import { spatialLayout } from "@pokapali/react";

const positioned = spatialLayout(
  items.map((c) => ({
    id: c.id,
    desiredY: anchorY,
    height: cardHeight,
  })),
);
// → [{ id, y }] with minimum 8px gap
```

## Indicator Components

Status and save-state indicators extracted from the
example app. Import the stylesheet for default styles:

```typescript
import "@pokapali/react/indicators.css";
```

All classes use BEM with a `pkp-` prefix
(`pkp-save-indicator`, `pkp-status-indicator`, etc.).

### SaveIndicator

Displays the current save state and doubles as a
publish button when the document is dirty or
unpublished.

```typescript
import {
  SaveIndicator,
  useFeed,
} from "@pokapali/react";

const saveState = useFeed(doc.saveState);
const ackCount = useFeed(doc.backedUp) ? 1 : 0;

<SaveIndicator
  saveState={saveState}
  ackCount={ackCount}
  onPublish={() => doc.publish()}
/>
```

**Props:**

| Prop        | Type                           | Description                                                                        |
| ----------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `saveState` | `SaveState`                    | Current save state from `doc.saveState` Feed.                                      |
| `ackCount`  | `number`                       | Number of servers that acknowledged the snapshot. Shows "Saved to N servers".      |
| `onPublish` | `() => void`                   | Called when the user clicks the button (visible in `dirty` / `unpublished` state). |
| `labels`    | `Partial<SaveIndicatorLabels>` | Override default English strings.                                                  |

### LastUpdated

Relative-time display that auto-refreshes every 5
seconds. Briefly flashes green after a snapshot event.

```typescript
import {
  LastUpdated,
  useFeed,
  useSnapshotFlash,
} from "@pokapali/react";

const tip = useFeed(doc.tip);
const flash = useSnapshotFlash(doc);

<LastUpdated
  timestamp={tip?.ts ?? 0}
  flash={flash}
/>
```

**Props:**

| Prop        | Type                           | Description                                        |
| ----------- | ------------------------------ | -------------------------------------------------- |
| `timestamp` | `number`                       | Unix timestamp (ms) of the last snapshot.          |
| `flash`     | `boolean`                      | When `true`, briefly highlights the text in green. |
| `labels`    | `Partial<SaveIndicatorLabels>` | Override the `lastUpdated` formatter.              |

### StatusIndicator

Connection status dot with label and optional
degraded-state warning.

```typescript
import {
  StatusIndicator,
  useFeed,
} from "@pokapali/react";

const status = useFeed(doc.status);

<StatusIndicator status={status} />
```

**Props:**

| Prop     | Type                             | Description                                       |
| -------- | -------------------------------- | ------------------------------------------------- |
| `status` | `DocStatus`                      | Current connection status from `doc.status` Feed. |
| `labels` | `Partial<StatusIndicatorLabels>` | Override default English strings.                 |

Status values: `"synced"` (green dot), `"receiving"`
(cyan), `"connecting"` (yellow + warning), `"offline"`
(red + warning).

### Indicator Labels (i18n)

Both `SaveIndicator`/`LastUpdated` and
`StatusIndicator` accept a `labels` prop:

```typescript
import type {
  SaveIndicatorLabels,
  StatusIndicatorLabels,
} from "@pokapali/react";

<SaveIndicator
  labels={{
    saved: "Gespeichert",
    dirty: "Änderungen speichern",
  }}
  ...
/>

<StatusIndicator
  labels={{
    synced: "Verbunden",
    offline: "Getrennt",
  }}
  ...
/>
```

Use `defaultSaveIndicatorLabels` and
`defaultStatusIndicatorLabels` to inspect or spread
from the built-in defaults.

## Peer Dependencies

- `@pokapali/core`
- `react` >= 18
- `@pokapali/comments` (for comment components)
- `@tiptap/pm` >= 2 (optional, for `CommentSidebar`
  spatial positioning)
- `yjs` >= 13.6 (optional, for `useComments`)

## Links

- [@pokapali/comments-tiptap](https://github.com/gnidan/pokapali/tree/main/packages/comments-tiptap) — Tiptap extensions for comment highlighting
- [Root README](https://github.com/gnidan/pokapali#readme)
