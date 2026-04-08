---
"@pokapali/core": patch
---

Fix WebSocket connection gater and relay reconnect loop

- Compose custom `denyDialMultiaddr` with browser default
  private-IP blocking (was lost when overriding the gater)
- Block plain ws:// dials in HTTPS contexts (mixed content)
- Fix reconnect loop: await relay tagging before considering
  dial successful, add stability window for backoff reset,
  add liveness check in disconnect handler
- Suppress benign "QueryManager not started" warnings
