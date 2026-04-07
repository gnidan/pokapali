---
"@pokapali/node": patch
---

feat(node): add --network-id CLI flag

Expose the pinner's networkId config via the CLI so
operators can partition topic namespaces without
code changes. Defaults to "main".
