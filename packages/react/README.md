# @pokapali/react

```sh
npm install @pokapali/react
```

React bindings for pokapali — hooks for document
state, and ready-made components for threaded
comments with spatial anchoring.

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
