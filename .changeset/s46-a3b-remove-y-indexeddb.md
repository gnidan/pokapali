---
"@pokapali/core": minor
---

Remove y-indexeddb dependency. Edit persistence now
handled entirely by Store (wired in A3a). One-time
hydration from old y-indexeddb databases for users
who haven't loaded since A3a — reads raw updates
from old `updates` object store and applies to Y.Docs.
Migration tracked per doc-guid in Store meta store.
Old databases left read-only.
