---
"@pokapali/core": patch
---

Extract interpreter effect handlers (announce with retry,
snapshot events, ack/guarantee dedup, gossip activity)
from create-doc.ts into effect-handlers.ts. Pure
extraction — zero behavior change.
