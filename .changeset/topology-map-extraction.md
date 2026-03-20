---
"@pokapali/react": minor
---

Extract TopologyMap component from example app to @pokapali/react

Adds TopologyMap with d3-force layout, particle animations, and SVG
rendering. Leaked internals removed: no peer IDs on infra nodes, no
guarantee halos/labels, simplified tooltips ("You", display names,
"Relay/Pinner — connected/has your latest changes"). Includes
TopologyMapLabels interface for i18n, topology-map.css stylesheet,
and 6 stories (Just You, Two Editors, Full Network, Editor
Disconnected, Server Down, Solo Offline).
