---
---

Switch to per-package git tags created by
`changeset publish` in GHA. Remove monorepo
`v<version>` tag from release.sh. Fix changelog
diff to show new (untracked) CHANGELOG files.
Guard against duplicate internal CHANGELOG entries.
Add tag push step to publish.yml.
