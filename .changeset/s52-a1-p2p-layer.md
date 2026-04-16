---
"@pokapali/core": patch
---

Extract P2P orchestration (Helia bootstrap, relay discovery,
multi-relay room wiring, signaling) from index.ts into
p2p-layer.ts. Pure extraction, zero behavior change.
