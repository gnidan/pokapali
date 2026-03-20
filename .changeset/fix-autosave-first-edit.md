---
"@pokapali/core": patch
---

#359 Fix autosave not firing for the first edit.

When createAutoSaver attaches after the doc is
already dirty (e.g. from populateMeta during create),
it now starts the debounce timer immediately instead
of waiting for the next publish-needed event that
never arrives.
