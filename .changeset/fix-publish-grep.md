---
---

Fix publish.yml grep pattern to match changeset
publish output prefixed with butterfly emoji.
Verification and tag push steps were skipped during
the 2026-03-19 validation release because the
`^New tag:` pattern didn't match `🦋  New tag:`.
