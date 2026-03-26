---
"@pokapali/document": patch
"@pokapali/core": patch
---

Evolve View interface to multi-channel design

- View<V> now has `channels` (map of channel names
  to Measured) and `combine` (merges per-channel
  results into final value)
- Add View.singleChannel helper for single-channel
  views
- Rename tree-level fold from `inspect` to `foldTree`
  (inspect reserved for PR2 document-level API)
- Migrate State view to singleChannel wrapper
- Migrate Fingerprint view to multi-channel
  (content + comments, SHA-256 + XOR)
- Feed.create and foldTree take Measured directly
- Registry.create takes channel name; activate
  extracts per-channel Measured from View
- Update @pokapali/core compat shims for new API
