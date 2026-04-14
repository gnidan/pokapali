---
"@pokapali/codec": minor
"@pokapali/core": minor
"@pokapali/react": patch
---

Y.Doc opacity: Doc.channel() and Doc.surface() now
return CodecSurface instead of Y.Doc.

- Add encodeStateVector(), encodeState(), and onEdit()
  to CodecSurface interface
- Eliminate all `as Y.Doc` casts in core (create-doc,
  doc-rotate) — route through CodecSurface methods
- Replace raw Y.Doc update handlers with
  surface.onEdit() in the edit bridge
- Remove STORE_ORIGIN / SNAPSHOT_ORIGIN from
  create-doc (handled by CodecSurface internally)
- Migrate external consumers to use `.handle as YDoc`
  where raw Y.Doc access is needed
