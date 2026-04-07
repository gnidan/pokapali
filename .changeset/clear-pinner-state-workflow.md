---
---

ops: add clear-pinner-state workflow, derive nodes from secret

Refactor deploy-relays.yml and add clear-pinner-state
workflow to derive all node lists dynamically from
DEPLOY_NODES_CONFIG secret via matrix strategy. Zero
node names hardcoded in workflow YAML.

clear-pinner-state.yml filters nodes by `roles`
containing `"pinner"`. deploy-relays.yml reads batch
structure from the secret. Both support skip_nodes.

Requires adding `"roles": ["relay", "pinner"]` to
pinner nodes in DEPLOY_NODES_CONFIG.
