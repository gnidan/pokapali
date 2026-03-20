---
"@pokapali/core": patch
---

#38 Fix markReady race when IPNS resolves before fetch starts

`deriveLoadingState` now returns `"resolving"` (instead of
`"idle"`) when IPNS has resolved a CID but the corresponding
chain entry still has `blockStatus: "unknown"`. This prevents
`markReady` from firing before the first snapshot is applied.
