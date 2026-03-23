---
"@pokapali/storybook": patch
"@pokapali/example": patch
---

Move 5 component stories (ConnectionStatus, EncryptionInfo,
SharePanel, ValidationWarning, VersionHistory) from storybook
app to example app, co-located with real components. Rewrite
to import actual components with prop-driven mock data.
