---
"@pokapali/node": patch
---

#394 Delete deactivated IPNS names after 7-day
retention instead of 14-day. Fixes history tracker
leak where orphaned entries accumulated across
restarts. Also cleans up history tracker entries
on name deletion.
