---
"@pokapali/core": patch
"@pokapali/sync": patch
---

#55 Pause periodic timers when browser tab is hidden.

Adds `createThrottledInterval`, a visibility-aware
`setInterval` wrapper that pauses (or throttles) when
the tab is backgrounded and optionally fires
immediately on resume.

Integrated into topology-sharing, relay-sharing,
node-registry, peer-discovery, and gossipsub-signaling
to eliminate unnecessary background CPU, network, and
battery usage.
