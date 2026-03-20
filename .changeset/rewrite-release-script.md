---
---

Rewrite release.sh to wrap @changesets/cli.
Replaces manual version-bump.mjs and per-package
tag logic with `changeset version` + single
`v<version>` tag. Adds changelog diff review
pause, interactive push confirmation, and
internal changeset extraction (non-package
changes injected into root CHANGELOG.md under
an "Internal" heading). Preserves old script
as release-legacy.sh for rollback.
