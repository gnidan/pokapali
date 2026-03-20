---
"@pokapali/core": patch
---

#120 Rename TopologyGraphEdge → TopologyEdge

Renames `TopologyGraphEdge` to `TopologyEdge` for consistency
with the `TopologyGraph` and `TopologyNode` naming convention.
The internal raw edge type (from node capability broadcasts)
is renamed from `TopologyEdge` to `CapabilityEdge`.
