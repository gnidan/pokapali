---
"@pokapali/node": patch
---

#378 Replace startup grace timer with resolveAll
completion flag.

Stale-resolve pruning is now gated on resolveAll()
having completed at least once, instead of a 10-minute
time-based grace window. This is the proper state-based
fix for the #376 startup mass-deletion bug — pruning
waits for fresh lastResolvedAt data rather than guessing
how long resolveAll() takes.
