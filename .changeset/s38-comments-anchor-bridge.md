---
"@pokapali/comments": patch
---

Add anchor bridge pattern: resolve anchors via merged
CRDT payload (from State view) instead of live Y.Doc.
New `contentPayload` option, `resolveAnchorFromPayload`,
`deriveTypeAccessor`, and `ContentTypeAccessor` type.
