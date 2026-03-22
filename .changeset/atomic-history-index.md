---
"@pokapali/node": patch
---

Make saveHistoryIndex atomic via write-to-tmp + rename,
preventing corrupt index files on crash (#380)
