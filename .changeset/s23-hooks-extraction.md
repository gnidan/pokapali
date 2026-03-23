---
"@pokapali/react": patch
---

Add useSaveLabel, useLastUpdated, and useStatusLabel hooks
that extract indicator logic from the deprecated SaveIndicator,
LastUpdated, and StatusIndicator components. Consumers can now
build custom indicator UIs without depending on library markup.
