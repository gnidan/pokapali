---
"@pokapali/core": patch
---

#289 Verify CID hash of inline blocks received via
GossipSub before storing in blockstore. Prevents
acceptance of tampered or corrupted blocks from the
gossip network. Shared verifyCid() utility extracted
for reuse across fetch-tip and gossip bridge.
