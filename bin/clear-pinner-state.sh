#!/usr/bin/env bash
set -euo pipefail

# Clear pinner state on a single node.
#
# Usage:
#   bin/clear-pinner-state.sh <node_name> \
#     [clear_blockstore] [dry_run]
#
# Looks up the node in deploy/nodes.json, SSHes in,
# stops the service, removes pinner state files,
# optionally clears the blockstore, restarts, and
# health-checks.
#
# Pinner state files:
#   pinner-state/   (LevelDB — tracked names, tips)
#   state.json      (persisted pinner state)
#   history-index.json (version history index)
#
# Exits 0 on success, 1 on failure.

NODE_NAME="$1"
CLEAR_BLOCKSTORE="${2:-false}"
DRY_RUN="${3:-false}"

CONFIG="deploy/nodes.json"

# Look up node
HOST=$(jq -r \
  ".batches[].nodes[] |
   select(.name==\"$NODE_NAME\") |
   .host" "$CONFIG")

if [ -z "$HOST" ] || [ "$HOST" = "null" ]; then
  echo "::error::Node '$NODE_NAME' not found" \
    "in config"
  exit 1
fi

# Read defaults
USER=$(jq -r '.defaults.user' "$CONFIG")
SERVICE=$(jq -r '.defaults.service' "$CONFIG")
PORT=$(jq -r '.defaults.health_port' "$CONFIG")
TIMEOUT=$(jq -r '.defaults.health_timeout' "$CONFIG")
RETRIES=$(jq -r '.defaults.health_retries' "$CONFIG")
RETRY_DELAY=$(jq -r \
  '.defaults.health_retry_delay' "$CONFIG")
STARTUP_WAIT=$(jq -r \
  '.defaults.startup_wait' "$CONFIG")

echo "=== $NODE_NAME ($HOST) ==="

# Resolve storage path from systemd unit
STORAGE=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "UNIT_FILE=\$(systemctl show -p FragmentPath \
    $SERVICE 2>/dev/null \
    | sed 's/FragmentPath=//'); \
   grep -oP '(?<=--storage-path\s)\S+' \
    \"\$UNIT_FILE\" 2>/dev/null || true")

if [ -z "$STORAGE" ]; then
  echo "::error::Could not resolve storage path" \
    "for $NODE_NAME"
  exit 1
fi

echo "  Storage path: $STORAGE"

if [ "$DRY_RUN" = "true" ]; then
  echo "  [DRY RUN] Would stop $SERVICE"
  echo "  [DRY RUN] Would clear pinner-state/"
  echo "  [DRY RUN] Would clear state.json"
  echo "  [DRY RUN] Would clear history-index.json"
  if [ "$CLEAR_BLOCKSTORE" = "true" ]; then
    echo "  [DRY RUN] Would clear blockstore/"
  fi
  echo "  [DRY RUN] Would start $SERVICE"
  echo "  [DRY RUN] Would health-check $NODE_NAME"
  exit 0
fi

# Pre-clear metrics
echo "  Pre-clear metrics:"
# shellcheck disable=SC2029
METRICS=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "curl -sf -m 5 http://localhost:$PORT/metrics" \
  2>/dev/null || echo "{}")
if [ "$METRICS" != "{}" ]; then
  echo "$METRICS" | jq -r '
    "    heapUsed: \(.memory.heapUsed // "n/a")",
    "    pinner: \(.pinner // "n/a")"' \
    2>/dev/null || echo "    (metrics unavailable)"
fi

# Stop service
echo "  Stopping $SERVICE..."
# shellcheck disable=SC2029
ssh -o ConnectTimeout=15 "$USER@$HOST" \
  "sudo systemctl stop $SERVICE"

# Clear pinner state
echo "  Clearing pinner state..."
# shellcheck disable=SC2029
ssh -o ConnectTimeout=15 "$USER@$HOST" \
  "rm -rf $STORAGE/pinner-state \
          $STORAGE/state.json \
          $STORAGE/history-index.json"

# Optionally clear blockstore
if [ "$CLEAR_BLOCKSTORE" = "true" ]; then
  echo "  Clearing blockstore..."
  # shellcheck disable=SC2029
  ssh -o ConnectTimeout=15 "$USER@$HOST" \
    "rm -rf $STORAGE/blockstore"
fi

# Restart service
echo "  Starting $SERVICE..."
# shellcheck disable=SC2029
ssh -o ConnectTimeout=15 "$USER@$HOST" \
  "sudo systemctl start $SERVICE"

# Wait for startup
echo "  Waiting ${STARTUP_WAIT}s for startup..."
sleep "$STARTUP_WAIT"

# Health check (no commit verification — we didn't
# deploy new code, just cleared state)
echo "  Health check..."
HEALTHY=false
for i in $(seq 1 "$RETRIES"); do
  HEALTH=$(ssh -o ConnectTimeout=15 \
    "$USER@$HOST" \
    "curl -sf -m $TIMEOUT \
      http://localhost:$PORT/health" \
    2>/dev/null || true)

  if [ -n "$HEALTH" ]; then
    HEALTHY=true
    break
  fi

  if [ "$i" -lt "$RETRIES" ]; then
    echo "  Health check $i/$RETRIES failed," \
      "retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  fi
done

if [ "$HEALTHY" != "true" ]; then
  echo "::error::$NODE_NAME health check failed" \
    "after $RETRIES attempts"
  exit 1
fi

# Service status
STATUS=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "systemctl is-active $SERVICE" \
  2>/dev/null || true)

if [ "$STATUS" != "active" ]; then
  echo "::error::$NODE_NAME service $SERVICE" \
    "is $STATUS after restart"
  exit 1
fi

echo "  $NODE_NAME complete. Pinner state cleared," \
  "service healthy."
