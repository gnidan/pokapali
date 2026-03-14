#!/usr/bin/env bash
set -euo pipefail

# Deploy a single batch from deploy/nodes.json.
#
# Usage:
#   bin/deploy-batch.sh <batch_index> <commit> \
#     [skip_nodes] [dry_run]
#
# Reads deploy/nodes.json for node config and defaults.
# Deploys all non-skipped nodes in the batch in parallel,
# waits for startup, then health-checks in parallel.
#
# Exits 0 on success, 1 on failure.

BATCH_INDEX="$1"
COMMIT="$2"
SKIP="${3:-}"
DRY_RUN="${4:-false}"

CONFIG="deploy/nodes.json"

# Read defaults
USER=$(jq -r '.defaults.user' "$CONFIG")
REPO_PATH=$(jq -r '.defaults.repo_path' "$CONFIG")
SERVICE=$(jq -r '.defaults.service' "$CONFIG")
PORT=$(jq -r '.defaults.health_port' "$CONFIG")
TIMEOUT=$(jq -r '.defaults.health_timeout' "$CONFIG")
RETRIES=$(jq -r '.defaults.health_retries' "$CONFIG")
RETRY_DELAY=$(jq -r \
  '.defaults.health_retry_delay' "$CONFIG")
STARTUP_WAIT=$(jq -r \
  '.defaults.startup_wait' "$CONFIG")

# Parse skip list
IFS=',' read -ra SKIP_ARR <<< "${SKIP:-}"

should_skip() {
  local name="$1"
  for s in "${SKIP_ARR[@]}"; do
    s=$(echo "$s" | xargs)
    if [ "$s" = "$name" ]; then
      return 0
    fi
  done
  return 1
}

BATCH_NAME=$(jq -r \
  ".batches[$BATCH_INDEX].name" "$CONFIG")
NODE_COUNT=$(jq \
  ".batches[$BATCH_INDEX].nodes | length" "$CONFIG")

echo "=== $BATCH_NAME ==="

# Collect nodes
BATCH_NODES=()
BATCH_HOSTS=()
for ((n=0; n<NODE_COUNT; n++)); do
  NAME=$(jq -r \
    ".batches[$BATCH_INDEX].nodes[$n].name" "$CONFIG")
  HOST=$(jq -r \
    ".batches[$BATCH_INDEX].nodes[$n].host" "$CONFIG")

  if should_skip "$NAME"; then
    echo "  Skipping $NAME"
    continue
  fi

  BATCH_NODES+=("$NAME")
  BATCH_HOSTS+=("$HOST")
done

if [ ${#BATCH_NODES[@]} -eq 0 ]; then
  echo "  All nodes skipped."
  exit 0
fi

# Deploy nodes in parallel
PIDS=()
for i in "${!BATCH_NODES[@]}"; do
  NAME="${BATCH_NODES[$i]}"
  HOST="${BATCH_HOSTS[$i]}"

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [DRY RUN] Would deploy $NAME ($HOST)"
  else
    bin/deploy-node.sh "$USER" "$HOST" \
      "$REPO_PATH" "$SERVICE" "$COMMIT" &
    PIDS+=($!)
  fi
done

# Wait for deploys
DEPLOY_FAILED=false
if [ ${#PIDS[@]} -gt 0 ]; then
  for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then
      DEPLOY_FAILED=true
    fi
  done
fi

if [ "$DEPLOY_FAILED" = "true" ]; then
  echo "::error::Deploy failed in $BATCH_NAME"
  exit 1
fi

if [ "$DRY_RUN" = "true" ]; then
  echo "  [DRY RUN] Would wait ${STARTUP_WAIT}s"
  for NAME in "${BATCH_NODES[@]}"; do
    echo "  [DRY RUN] Would health-check $NAME"
  done
  exit 0
fi

# Wait for startup
echo "  Waiting ${STARTUP_WAIT}s for startup..."
sleep "$STARTUP_WAIT"

# Health check in parallel
PIDS=()
for i in "${!BATCH_NODES[@]}"; do
  HOST="${BATCH_HOSTS[$i]}"
  bin/health-check.sh "$USER" "$HOST" \
    "$REPO_PATH" "$SERVICE" "$COMMIT" \
    "$PORT" "$TIMEOUT" "$RETRIES" \
    "$RETRY_DELAY" &
  PIDS+=($!)
done

HEALTH_FAILED=false
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    HEALTH_FAILED=true
  fi
done

if [ "$HEALTH_FAILED" = "true" ]; then
  echo "::error::Health check failed in $BATCH_NAME"
  exit 1
fi

echo "  $BATCH_NAME complete. All nodes healthy."
