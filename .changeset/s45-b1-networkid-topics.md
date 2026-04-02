---
"@pokapali/core": patch
"@pokapali/sync": patch
"@pokapali/node": patch
---

Add networkId to all GossipSub topic strings and
signaling room names so test/production traffic
never crosses. The new `networkId` option on
`PokapaliConfig` defaults to `"main"`.
