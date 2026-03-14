#!/usr/bin/env bash
set -euo pipefail

# Deploy and health-check a single node by name.
#
# Usage:
#   bin/deploy-single-node.sh <node_name> <commit> \
#     [dry_run]
#
# Looks up the node in deploy/nodes.json, deploys it,
# waits for startup, then runs health checks.
#
# Exits 0 on success, 1 on failure.

NODE_NAME="$1"
COMMIT="$2"
DRY_RUN="${3:-false}"

CONFIG="deploy/nodes.json"

# Look up node
HOST=$(jq -r \
  ".batches[].nodes[] |
   select(.name==\"$NODE_NAME\") |
   .host" "$CONFIG")

if [ -z "$HOST" ] || [ "$HOST" = "null" ]; then
  echo "::error::Node '$NODE_NAME' not found in config"
  exit 1
fi

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

echo "=== $NODE_NAME ($HOST) ==="

if [ "$DRY_RUN" = "true" ]; then
  echo "  [DRY RUN] Would deploy $NODE_NAME ($HOST)"
  echo "  [DRY RUN] Would wait ${STARTUP_WAIT}s"
  echo "  [DRY RUN] Would health-check $NODE_NAME"
  exit 0
fi

# Deploy
bin/deploy-node.sh "$USER" "$HOST" \
  "$REPO_PATH" "$SERVICE" "$COMMIT"

# Wait for startup
echo "  Waiting ${STARTUP_WAIT}s for startup..."
sleep "$STARTUP_WAIT"

# Health check
bin/health-check.sh "$USER" "$HOST" \
  "$REPO_PATH" "$SERVICE" "$COMMIT" \
  "$PORT" "$TIMEOUT" "$RETRIES" "$RETRY_DELAY"

echo "  $NODE_NAME complete. Healthy."
