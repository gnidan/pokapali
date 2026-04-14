---
"@pokapali/core": patch
---

Fix relay waiter resolution order (!419 regression)

Resolve relay waiters before awaiting peerStore tag
to prevent signaling timeout when peerStore.merge
stalls.
