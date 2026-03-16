#!/usr/bin/env bash
set -euo pipefail

# S1: Relay Kill Mid-Session
#
# 1. Start 4-relay fleet (2 pinners, 2 relay-only)
# 2. Run load test for BASELINE_S (60s)
# 3. Kill relay-2 (relay-only)
# 4. Continue for DEGRADED_S (120s)
# 5. Analyze: degraded ack rate >= 80% of baseline
#
# Usage:
#   chaos-s1.sh [--output DIR] [--baseline S]
#     [--degraded S] [--writers N]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="/tmp/chaos-s1"
BASELINE_S=60
DEGRADED_S=120
WRITERS=20
APP_ID="pokapali-chaos-test"
RELAY_COUNT=4
PIN_COUNT=2
BASE_PORT=3000
BASE_TCP_PORT=4001

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --baseline) BASELINE_S="$2"; shift 2 ;;
    --degraded) DEGRADED_S="$2"; shift 2 ;;
    --writers) WRITERS="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

TOTAL_S=$((BASELINE_S + DEGRADED_S))
KILL_AT_S=$BASELINE_S

mkdir -p "$OUTPUT_DIR"

echo "=== S1: Relay Kill Mid-Session ==="
echo "  Relays: $RELAY_COUNT (${PIN_COUNT} pinners)"
echo "  Writers: $WRITERS"
echo "  Baseline: ${BASELINE_S}s"
echo "  Degraded: ${DEGRADED_S}s"
echo "  Kill relay-2 at: ${KILL_AT_S}s"

# Start fleet
"$SCRIPT_DIR/chaos-fleet.sh" start "$RELAY_COUNT" \
  --base-port "$BASE_PORT" \
  --base-tcp-port "$BASE_TCP_PORT" \
  --pin-count "$PIN_COUNT" \
  --app-id "$APP_ID"

# Build bootstrap flags from fleet
BOOTSTRAPS=""
while IFS= read -r addr; do
  BOOTSTRAPS+=" --bootstrap $addr"
done < <("$SCRIPT_DIR/chaos-fleet.sh" bootstrap)

cleanup() {
  "$SCRIPT_DIR/chaos-fleet.sh" stop || true
}
trap cleanup EXIT

# Schedule relay kill in background
(
  sleep "$KILL_AT_S"
  echo ""
  echo ">>> KILLING relay-2 at ${KILL_AT_S}s <<<"
  KILL_PID=$(cat /tmp/chaos-relay-2.pid 2>/dev/null)
  if [ -n "$KILL_PID" ]; then
    kill -9 "$KILL_PID" 2>/dev/null || true
    rm -f /tmp/chaos-relay-2.pid
    echo ">>> relay-2 killed (PID $KILL_PID) <<<"
  fi
) &
KILL_JOB=$!

# Run load test (no churn — stable writer pool)
# churn-interval=999999 effectively disables churn
# (churn-size=0 makes cycles no-ops anyway, but
# interval=0 would spin CPU via setTimeout(fn, 0))
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers 0 \
  --duration "$TOTAL_S" \
  --churn-interval 999999 \
  --churn-size 0 \
  --stabilize 0 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s1.jsonl" \
  $BOOTSTRAPS

wait "$KILL_JOB" 2>/dev/null || true

echo ""
echo "=== S1: Analyzing results ==="

node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s1.jsonl" \
  --max-errors 10 \
  --ack-rate 50 \
  --phase "baseline:0:$BASELINE_S" \
  --phase "degraded:$BASELINE_S:$TOTAL_S" \
  --phase-ack-rate "baseline:80" \
  --phase-ack-rate "degraded:60"
