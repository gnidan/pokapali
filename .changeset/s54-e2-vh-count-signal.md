---
"@pokapali/example": patch
---

Expose hidden version-history count signal in
Editor for E2E observability. Adds
`data-testid="versions-feed"` and
`data-version-count` attributes on a hidden element
that mirrors `useVersionHistory.versions.length`,
enabling D4b smoke tests to verify peer-arrived
snapshot ingestion without opening the History
drawer.
