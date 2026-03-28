---
"@pokapali/core": patch
---

Fix loadVersion test: use valid Ed25519 keypair in
identity mock (zero-seed public key) and fix
hasTreeContent guard to check editCount instead of
tree.tag (fresh channels have a "single" tree with
one empty epoch, not an "empty" tree).
