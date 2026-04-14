---
"@pokapali/core": patch
---

Fix idle reconnection: retry on failed redial, resume on tab visible

- Extract `scheduleReconnect` and call it recursively on
  failed redial — previously a single failed attempt
  abandoned the relay until DHT re-discovery
- On tab visibility resume, cancel stale reconnect timers
  and immediately redial disconnected relays with fresh
  backoff — browsers throttle/suspend timers in background
  tabs, delaying recovery
