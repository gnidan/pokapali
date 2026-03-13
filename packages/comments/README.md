# @pokapali/comments

```sh
npm install @pokapali/comments
```

Anchored, attributed, threaded comments for Yjs
documents. Generic over app-defined comment data `T`.
Does **not** depend on `@pokapali/core` — works with
any Yjs setup.

## Quick Start

```typescript
import { comments } from "@pokapali/comments";
import { createFeed } from "@pokapali/comments";
import * as Y from "yjs";

const commentsDoc = new Y.Doc();
const contentDoc = new Y.Doc();
contentDoc.getText("default").insert(0, "Hello world");

const c = comments<{ status: "open" | "resolved" }>(commentsDoc, contentDoc, {
  author: "alice-pubkey",
  clientIdMapping: createFeed(new Map()),
});

// Add a comment anchored to "Hello".
const id = c.add({
  content: "Fix this greeting.",
  anchor: c.createAnchor(0, 5),
  data: { status: "open" },
});

// Subscribe to the reactive comment list.
c.feed.subscribe(() => {
  console.log(c.feed.getSnapshot());
});
```

## Key Exports

- **`comments<T>(commentsDoc, contentDoc, options)`** —
  factory returning a `Comments<T>` instance
- **`CommentsOptions`** — `author`, `clientIdMapping`
  (reactive Feed), optional `contentType` for
  XmlFragment/Tiptap
- **`Comments<T>`** — `feed`, `createAnchor()`,
  `add()`, `update()`, `delete()`, `destroy()`
- **`Comment<T>`** — projected comment with `id`,
  `author`, `authorVerified`, `content`, `ts`,
  `anchor`, `parentId`, `children`, `data`
- **`Anchor`** — opaque encoded RelativePosition pair
- **`ResolvedAnchor`** — `"resolved"` (with indices),
  `"orphaned"`, or `"pending"`
- **`anchorFromRelativePositions(start, end)`** —
  build an Anchor from pre-existing RelativePositions
  (for y-prosemirror / Tiptap integration)
- **`Feed<T>`** — reactive value container compatible
  with React's `useSyncExternalStore`
- **`ClientIdMapping`** / **`ClientIdentityInfo`** —
  types for author verification

## Features

- **Anchoring** — comments track text positions via
  Y.RelativePosition; anchors survive concurrent edits
- **Generic content type** — works with Y.Text (default)
  or Y.XmlFragment (Tiptap/ProseMirror) via the
  `contentType` option
- **Author verification** — cross-references Yjs
  clientID against a pubkey mapping to verify authorship
- **One-level threading** — replies nest under parents;
  reply-to-reply is disallowed
- **Reactive feed** — `feed.getSnapshot()` /
  `feed.subscribe()` for UI binding
- **CRDT sync** — comments live in a Y.Map and merge
  across peers automatically

## Links

- [Root README](../../README.md)
