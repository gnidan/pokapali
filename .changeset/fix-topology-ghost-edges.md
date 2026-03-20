---
"@pokapali/core": patch
---

#349 Fix topology graph edges ghosting after extended
use.

Deduplicate edges in buildTopologyGraph() using
normalized endpoint keys — the same relay-relay edge
reported from multiple sources (node-registry and peer
awareness) no longer produces duplicates. Also skip
null awareness states from disconnected peers to
prevent ghost browser nodes and edges.
