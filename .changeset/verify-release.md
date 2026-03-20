---
---

Add verify-release.sh for post-publish verification.
Polls npm for published packages, checks version
availability and dist-tag correctness (latest vs next).
Can auto-detect packages from HEAD commit or accept
explicit package@version arguments.
