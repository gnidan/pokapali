# @pokapali/comments-tiptap

```sh
npm install @pokapali/comments-tiptap
```

Tiptap/ProseMirror adapter for `@pokapali/comments`.
Bridges Y.RelativePosition anchors to ProseMirror
document positions and provides editor extensions
for comment highlighting.

> **React apps:** `@pokapali/react` provides
> ready-made `useComments`, `CommentSidebar`, and
> `CommentPopover` components. Use them alongside
> the Tiptap extensions from this package — see
> [React integration](#react-integration) below.

## Quick Start

```typescript
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import {
  anchorFromSelection,
  CommentHighlight,
  PendingAnchorHighlight,
  resolveAnchors,
} from "@pokapali/comments-tiptap";
import { comments } from "@pokapali/comments";

// Set up comments on your Yjs docs
const c = comments<MyData>(commentsDoc, contentDoc, {
  author: myPubkey,
  clientIdMapping,
});

// Configure the editor with comment extensions
const editor = new Editor({
  extensions: [
    Collaboration.configure({
      document: contentDoc,
    }),
    CommentHighlight.configure({
      commentsDoc,
      contentDoc,
      activeCommentId: null,
    }),
    PendingAnchorHighlight,
  ],
});

// Create a comment from the current selection
const anchor = anchorFromSelection(editor);
if (anchor) {
  c.add({ content: "Needs work", anchor, data: {} });
}
```

## Key Exports

### Anchor Bridge

- **`anchorFromSelection(editor)`** — creates an
  `Anchor` from the current editor selection.
  Returns `null` if selection is collapsed or sync
  plugin is inactive.

### Bulk Resolution

- **`resolveAnchors(commentsDoc, contentDoc, syncState)`**
  — resolves all comment anchors to ProseMirror
  `{ id, from, to }` positions. Skips orphaned or
  degenerate anchors.

### Extensions

- **`CommentHighlight`** — Tiptap extension that
  creates inline decorations (`.comment-anchor`,
  `.active`) for resolved comment anchors. Rebuilds
  on doc changes. Configure with `commentsDoc`,
  `contentDoc`, and `activeCommentId`.
- **`rebuildCommentDecorations(view)`** — dispatch a
  transaction to force-rebuild decorations (call when
  comments change externally).
- **`PendingAnchorHighlight`** — Tiptap extension
  that highlights the anchor being created before
  submission (`.pending-anchor`). Tracks concurrent
  edits.
- **`setPendingAnchorDecoration(view, anchor)`** /
  **`clearPendingAnchorDecoration(view)`** — control
  the pending highlight imperatively.

### Re-exports

- **`Anchor`** — re-exported from `@pokapali/comments`

## React Integration

For React + Tiptap apps, combine the extensions from
this package with the high-level components from
`@pokapali/react`:

```sh
npm install @pokapali/comments-tiptap \
  @pokapali/react @pokapali/comments
```

**This package** provides the Tiptap-specific parts:

- `CommentHighlight` / `PendingAnchorHighlight` —
  editor extensions for anchor highlighting
- `anchorFromSelection(editor)` — create anchors
  from the current editor selection
- `resolveAnchors()` / `getSyncState()` — map
  comment IDs to ProseMirror positions

**`@pokapali/react`** provides the data and UI layer:

- `useComments(doc)` — reactive comment list with
  CRUD actions (`addComment`, `addReply`,
  `updateComment`, `deleteComment`)
- `CommentSidebar` — threaded comment list with
  spatial anchoring, i18n labels, and
  resolve/reopen/delete actions
- `CommentPopover` — floating button that appears
  on text selection

Wire them together by passing this package's
extensions to the editor and `@pokapali/react`'s
components to the UI:

```typescript
import {
  CommentHighlight,
  PendingAnchorHighlight,
  anchorFromSelection,
  resolveAnchors,
  getSyncState,
} from "@pokapali/comments-tiptap";
import { useComments, CommentSidebar, CommentPopover } from "@pokapali/react";

// 1. useComments() handles the data layer
const { comments, addComment, commentsDoc } = useComments(doc);

// 2. Pass extensions to useEditor()
const editor = useEditor(
  {
    extensions: [
      Collaboration.configure({
        document: doc.channel("content"),
      }),
      CommentHighlight.configure({
        commentsDoc,
        contentDoc: doc.channel("content"),
        activeCommentId: null,
      }),
      PendingAnchorHighlight,
    ],
  },
  [doc],
);

// 3. Create anchors via anchorFromSelection()
const anchor = anchorFromSelection(editor);

// 4. Resolve positions for spatial layout
const syncState = getSyncState(editor);
const positions = resolveAnchors(
  commentsDoc,
  doc.channel("content"),
  syncState,
);
```

See `apps/example/` for a complete working
integration with all props wired up.

## Peer Dependencies

- `@pokapali/comments`
- `@tiptap/core` >= 2
- `@tiptap/pm` >= 2
- `y-prosemirror` >= 1
- `yjs` >= 13.6

## Links

- [@pokapali/comments README](https://github.com/gnidan/pokapali/blob/main/packages/comments/README.md)
- [Root README](https://github.com/gnidan/pokapali#readme)
