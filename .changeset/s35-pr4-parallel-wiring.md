---
"@pokapali/core": minor
---

Wire App/Document lifecycle bridge alongside existing
createDoc flow. pokapali() now creates a Document
(from @pokapali/document) for each doc and passes it
through to createDoc via docDocuments WeakMap. App
uses bridged Documents when available, falling back
to standalone Document creation. All existing behavior
unchanged — dual-system bridge.
