---
"@pokapali/core": patch
---

Delete view compat shims from @pokapali/core

Remove 16 files (8 source + 8 tests) in
packages/core/src/view/ that were thin wrappers
around @pokapali/document APIs. Update 3 consumer
test files to import directly from @pokapali/document.
