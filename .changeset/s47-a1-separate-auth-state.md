---
"@pokapali/core": minor
---

Remove authorizedPublishers and extract auth state
from metaDoc.

IPNS key possession is the sole authorization to
publish — the separate publisher allowlist was
redundant. Removed `authorize()`, `deauthorize()`,
`authorizedPublishers` from the Doc interface, and
`isPublisherAuthorized()` from the interpreter
pipeline. Deleted `populateMeta()` which populated
`canPushSnapshots` and `authorized` Y.Arrays in the
metaDoc (these are already available as plain values
on the Capability object derived from URL keys).
