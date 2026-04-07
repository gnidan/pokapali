---
---

ops: restore GHA visual graph for relay deploys

Rework deploy-relays.yml to use dynamic matrix
strategy with per-batch jobs. Setup job reads
DEPLOY_NODES_CONFIG and outputs per-batch matrices.
Batch jobs use strategy.matrix for parallel per-node
deploys. Restores per-node job graph in GHA UI while
keeping all node config in the secret. Supports up
to 5 batches; unused slots auto-skip.
