---
---

Rewrite release.sh to wrap @changesets/cli.
Replaces manual version-bump.mjs and per-package
tag logic with `changeset version` + single
`v<version>` tag. Adds changelog diff review
pause and interactive push confirmation. Preserves
old script as release-legacy.sh for rollback.
