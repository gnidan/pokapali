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

# 3. Commit verification (git repo)
RAW_ACTUAL=$(ssh -o ConnectTimeout=15 \
  "$USER@$HOST" \
  "cd $REPO_PATH && git rev-parse HEAD" \
  2>/dev/null)
ACTUAL=$(echo "$RAW_ACTUAL" | tr -cd '[:xdigit:]')
EXPECTED=$(echo "$COMMIT" | tr -cd '[:xdigit:]')

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "[$HOST] FAIL: expected commit ${EXPECTED:0:7}," \
    "got ${ACTUAL:0:7}"
  echo "[$HOST] DEBUG expected hex:" \
    "$(echo -n "$COMMIT" | xxd -p)"
  echo "[$HOST] DEBUG actual hex:" \
    "$(echo -n "$RAW_ACTUAL" | xxd -p)"
  exit 1
fi

# 4. Running process commit verification (smoke check)
# Confirms the running process was restarted with
# the new code, not just the git checkout.
HEALTH_COMMIT=$(echo "$HEALTH" \
  | jq -r '.commit // empty' 2>/dev/null || true)
if [ -n "$HEALTH_COMMIT" ]; then
  HC_CLEAN=$(echo "$HEALTH_COMMIT" \
    | tr -cd '[:xdigit:]')
  if [ "$HC_CLEAN" != "$EXPECTED" ]; then
    echo "[$HOST] FAIL: running process reports" \
      "commit ${HC_CLEAN:0:7}," \
      "expected ${EXPECTED:0:7}"
    echo "[$HOST] The service may not have" \
      "restarted properly."
    exit 1
  fi
  echo "[$HOST] Smoke check: running process" \
    "confirmed at ${HC_CLEAN:0:7}"
fi

echo "[$HOST] Healthy. Commit ${COMMIT:0:7}," \
  "service active."
