#!/usr/bin/env bash
set -euo pipefail

# Clear pinner state on all pinner nodes.
#
# Usage:
#   bin/clear-all-pinners.sh [skip_nodes] \
#     [clear_blockstore] [dry_run]
#
# Reads node list from deploy/nodes.json (written
# from DEPLOY_NODES_CONFIG secret). Filters to
# nodes with "pinner" in their roles array.
# Processes nodes sequentially to keep the fleet
# mostly available during clearing.
#
# Exits 0 on success, 1 on failure.

SKIP="${1:-}"
CLEAR_BLOCKSTORE="${2:-false}"
DRY_RUN="${3:-false}"

CONFIG="deploy/nodes.json"

# Validate config (roles required for pinner filtering)
bin/validate-nodes-config.sh --require-roles
echo ""

# Extract pinner nodes (those with "pinner" role)
PINNERS=$(jq -r '
  .batches[].nodes[]
  | select(.roles and
      (.roles | index("pinner")))
  | .name' "$CONFIG")

if [ -z "$PINNERS" ]; then
  echo "::error::No pinner nodes found in config"
  exit 1
fi

# Filter skipped nodes
NODES=()
for node in $PINNERS; do
  SKIPPED=false
  if [ -n "$SKIP" ]; then
    IFS=',' read -ra SKIP_LIST <<< "$SKIP"
    for s in "${SKIP_LIST[@]}"; do
      if [ "$s" = "$node" ]; then
        SKIPPED=true
        break
      fi
    done
  fi
  if [ "$SKIPPED" = "false" ]; then
    NODES+=("$node")
  fi
done

if [ ${#NODES[@]} -eq 0 ]; then
  echo "All pinner nodes skipped."
  exit 0
fi

echo "=== Clear Pinner State ==="
echo "Nodes: ${NODES[*]}"
echo "Clear blockstore: $CLEAR_BLOCKSTORE"
echo "Dry run: $DRY_RUN"
echo ""

FAILED=()
for node in "${NODES[@]}"; do
  if ! bin/clear-pinner-state.sh \
    "$node" "$CLEAR_BLOCKSTORE" "$DRY_RUN"; then
    FAILED+=("$node")
    echo "::error::$node failed — stopping"
    break
  fi
  echo ""
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "::error::Failed nodes: ${FAILED[*]}"
  exit 1
fi

echo "All pinner nodes cleared successfully."
