---
"@pokapali/store": patch
---

Fix recovery from buggy deployment (!392) that set
per-guid y-indexeddb migration flags without writing
edits. Migration now verifies edits exist before
trusting the flag; re-migrates if empty.
