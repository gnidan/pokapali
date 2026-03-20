---
"@pokapali/node": patch
---

#288 Validate snapshot before storing inline blocks
in pinner blockstore. Previously, invalid blocks from
GossipSub announcements were stored before validation,
leaving garbage data in the blockstore.
