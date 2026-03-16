# Comments Example

Minimal Tiptap editor with anchored, threaded
comments using `@pokapali/comments` and
`@pokapali/comments-tiptap`.

## What this demonstrates

- Creating a `comments()` instance on a channel
- Wiring `CommentHighlight` and
  `PendingAnchorHighlight` Tiptap extensions
- Creating anchored comments from editor selection
- Rendering a sidebar with spatially-ordered comments
- Replying, resolving, and deleting comments
- Using `@pokapali/react` hooks (`useFeed`,
  `useDocReady`)

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The admin URL is
logged to the console — share it (or the write/read
URLs) to test multi-peer collaboration.

## Key integration points

1. **Channel setup** — declare both `"content"` and
   `"comments"` in `pokapali()` config
2. **Content type** — pass
   `contentDoc.getXmlFragment("default")` (not
   `getText`) for Tiptap
3. **Anchor creation** — `anchorFromSelection(editor)`
   maps the current selection to a CRDT-stable range
4. **Highlight rebuild** — call
   `rebuildCommentDecorations(editor.view)` when
   comments or active selection change
5. **Spatial ordering** — `resolveAnchors()` maps
   comment IDs to editor positions for sidebar layout

See the [integration guide](../../integration-guide.md)
for full API documentation.
