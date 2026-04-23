---
"@pokapali/core": patch
---

Fix save-state race on deferred P2P startup

Hoist factQueue into createDoc scope so content-dirty
facts pushed before the interpreter starts are buffered
instead of silently dropped. Remove one-shot contentDirty
guard. Replace all runtime?.factQueue.push sites with the
hoisted queue.

Fixes: save indicator stuck on "Saved to N pinners" after
edits on second browser joining via IPNS.
