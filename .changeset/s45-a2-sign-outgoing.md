---
"@pokapali/core": patch
---

Wire edit signing into outgoing paths. Live edit
forwarding and reconciliation EDIT_BATCH messages
now carry 97-byte signed envelopes when an identity
keypair is present. Edit bridge stays synchronous
(empty sig) for epoch tree availability; signing
happens on-the-fly at the wire boundary.
