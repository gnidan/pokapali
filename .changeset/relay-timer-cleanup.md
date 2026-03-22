---
"@pokapali/node": patch
---

Capture uncaptured relay setTimeout handles (45s
initial provide, 15s cert re-dial) and clear them
in stop() to prevent leaked timers (#381)
