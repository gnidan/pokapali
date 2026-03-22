---
---

Fix publish.yml tag creation: explicitly create
per-package git tags instead of relying on changeset
publish, which does not reliably persist tags in
shallow clones (#384)
