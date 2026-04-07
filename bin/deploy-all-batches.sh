#!/usr/bin/env bash
set -euo pipefail

# Deploy all relay nodes in batches.
#
# Usage:
#   bin/deploy-all-batches.sh <commit> \
#     [skip_nodes] [dry_run]
#
# Reads batch structure from deploy/nodes.json
# (written from DEPLOY_NODES_CONFIG secret).
# Nodes within a batch deploy in parallel; batches
# run sequentially. If any node in a batch fails,
# the script stops (no subsequent batches).
#
# Exits 0 on success, 1 on failure.

COMMIT="$1"
SKIP="${2:-}"
DRY_RUN="${3:-false}"

CONFIG="deploy/nodes.json"

# Validate config before proceeding
bin/validate-nodes-config.sh
echo ""

BATCH_COUNT=$(jq '.batches | length' "$CONFIG")
echo "=== Deploy Plan ==="
echo "Commit: ${COMMIT:0:7}"
echo "Batches: $BATCH_COUNT"
echo "Skip: ${SKIP:-none}"
echo "Dry run: $DRY_RUN"
echo ""

for b in $(seq 0 $((BATCH_COUNT - 1))); do
  NODES=$(jq -r \
    --argjson idx "$b" \
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
    echo "=== Batch $((b+1))/$BATCH_COUNT:" \
      "all skipped ==="
    continue
  fi

  echo "=== Batch $((b+1))/$BATCH_COUNT:" \
    "${BATCH_NODES[*]} ==="

  # Deploy nodes in this batch in parallel
  PIDS=()
  FAILED=()
  for node in "${BATCH_NODES[@]}"; do
    (
      bin/deploy-single-node.sh \
        "$node" "$COMMIT" "$DRY_RUN"
    ) &
    PIDS+=("$!:$node")
  done

  # Wait for all nodes in this batch
  for entry in "${PIDS[@]}"; do
    PID="${entry%%:*}"
    NODE="${entry##*:}"
    if ! wait "$PID"; then
      FAILED+=("$NODE")
    fi
  done

  if [ ${#FAILED[@]} -gt 0 ]; then
    echo "::error::Batch $((b+1)) failed:" \
      "${FAILED[*]}"
    exit 1
  fi

  echo "=== Batch $((b+1)) complete ==="
  echo ""
done

echo "All batches deployed successfully."
