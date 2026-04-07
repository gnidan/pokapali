#!/usr/bin/env bash
set -euo pipefail

# Deploy a single batch (by 0-based index) with
# parallel node deploys.
#
# Usage:
#   bin/deploy-batch.sh <batch_index> <commit> \
#     [skip_nodes] [dry_run]
#
# Reads batch structure from deploy/nodes.json.
# Nodes within the batch deploy in parallel.
# Exits 0 on success, 1 on failure.

BATCH_IDX="$1"
COMMIT="$2"
SKIP="${3:-}"
DRY_RUN="${4:-false}"

CONFIG="deploy/nodes.json"

# Validate config
bin/validate-nodes-config.sh

NODES=$(jq -r \
  --argjson idx "$BATCH_IDX" \
  '.batches[$idx].nodes[].name' "$CONFIG")

# Filter skipped nodes
BATCH_NODES=()
for node in $NODES; do
  SKIPPED=false
  IFS=',' read -ra SKIP_LIST <<< "$SKIP"
  for s in "${SKIP_LIST[@]}"; do
    if [ "$s" = "$node" ]; then
      SKIPPED=true
      break
    fi
  done
  if [ "$SKIPPED" = "false" ]; then
    BATCH_NODES+=("$node")
  fi
done

if [ ${#BATCH_NODES[@]} -eq 0 ]; then
  echo "Batch $((BATCH_IDX+1)): all nodes skipped"
  exit 0
fi

echo "=== Batch $((BATCH_IDX+1)):" \
  "${BATCH_NODES[*]} ==="

# Deploy nodes in parallel
PIDS=()
FAILED=()
for node in "${BATCH_NODES[@]}"; do
  (
    bin/deploy-single-node.sh \
      "$node" "$COMMIT" "$DRY_RUN"
  ) &
  PIDS+=("$!:$node")
done

# Wait for all nodes
for entry in "${PIDS[@]}"; do
  PID="${entry%%:*}"
  NODE="${entry##*:}"
  if ! wait "$PID"; then
    FAILED+=("$NODE")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "::error::Batch $((BATCH_IDX+1)) failed:" \
    "${FAILED[*]}"
  exit 1
fi

echo "=== Batch $((BATCH_IDX+1)) complete ==="
