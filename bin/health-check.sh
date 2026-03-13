#!/usr/bin/env bash
set -euo pipefail

# Health-check a single node: HTTP health endpoint,
# commit hash verification, service status.
#
# Usage:
#   bin/health-check.sh <user> <host> <repo_path> \
#     <service> <commit> <port> <timeout> <retries> \
#     <retry_delay>
#
# Exits 0 on success, 1 on failure.

USER="$1"
HOST="$2"
REPO_PATH="$3"
SERVICE="$4"
COMMIT="$5"
PORT="$6"
TIMEOUT="$7"
RETRIES="$8"
RETRY_DELAY="$9"

echo "[$HOST] Checking health..."

# 1. Service status
STATUS=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "systemctl is-active $SERVICE" 2>/dev/null || true)

if [ "$STATUS" != "active" ]; then
  echo "[$HOST] FAIL: service $SERVICE is $STATUS"
  exit 1
fi

# 2. HTTP health with retries
HEALTHY=false
for i in $(seq 1 "$RETRIES"); do
  HEALTH=$(ssh -o ConnectTimeout=15 \
    "$USER@$HOST" \
    "curl -sf -m $TIMEOUT http://localhost:$PORT/health" \
    2>/dev/null || true)

  if [ -n "$HEALTH" ]; then
    HEALTHY=true
    break
  fi

  if [ "$i" -lt "$RETRIES" ]; then
    echo "[$HOST] Health check $i/$RETRIES failed," \
      "retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  fi
done

if [ "$HEALTHY" != "true" ]; then
  echo "[$HOST] FAIL: health endpoint unresponsive" \
    "after $RETRIES attempts"
  exit 1
fi

# 3. Commit verification
ACTUAL=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "cd $REPO_PATH && git rev-parse HEAD" \
  | tr -d '[:space:]')

if [ "$ACTUAL" != "$COMMIT" ]; then
  echo "[$HOST] FAIL: expected commit ${COMMIT:0:7}," \
    "got ${ACTUAL:0:7}"
  exit 1
fi

echo "[$HOST] Healthy. Commit ${COMMIT:0:7}," \
  "service active."
