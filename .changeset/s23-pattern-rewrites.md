---
"@pokapali/storybook": patch
"@pokapali/example": patch
---

Move 3 pattern stories (HistoryPreview,
NetworkDiagnostics, ShareAccess) and TopologyMap
component story to example app, co-located with
real components. Rewrite patterns to use
VersionHistory, ConnectionStatusView, SharePanel,
and EncryptionInfo directly instead of inline fakes.
