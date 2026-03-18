# @pokapali/comments-tiptap

```sh
npm install @pokapali/comments-tiptap
```

Tiptap/ProseMirror adapter for `@pokapali/comments`.
Bridges Y.RelativePosition anchors to ProseMirror
document positions and provides editor extensions
for comment highlighting.

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

## Peer Dependencies

- `@pokapali/comments`
- `@tiptap/core` >= 2
- `@tiptap/pm` >= 2
- `y-prosemirror` >= 1
- `yjs` >= 13.6

## Links

- [@pokapali/comments README](../comments/README.md)
- [Root README](../../README.md)
