#!/usr/bin/env bash
set -euo pipefail

# S4: Rapid Peer Churn
#
# 1. Start 4-relay fleet
# 2. Run stable baseline for BASELINE_S (60s)
# 3. Enable aggressive churn for CHURN_S (180s)
# 4. Stop churn, run recovery for RECOVERY_S (60s)
# 5. Analyze per-phase ack rates
#
# Uses the existing ChurnScheduler from bin/churn.ts.
# Three separate churn.js runs because the scheduler
# has no pause API.
#
# Usage:
#   chaos-s4.sh [--output DIR] [--baseline S]
#     [--churn S] [--recovery S] [--writers N]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="/tmp/chaos-s4"
BASELINE_S=60
CHURN_S=180
RECOVERY_S=60
WRITERS=10
APP_ID="pokapali-chaos-test"
RELAY_COUNT=4
PIN_COUNT=2
BASE_PORT=3000
BASE_TCP_PORT=4001

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --baseline) BASELINE_S="$2"; shift 2 ;;
    --churn) CHURN_S="$2"; shift 2 ;;
    --recovery) RECOVERY_S="$2"; shift 2 ;;
    --writers) WRITERS="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

echo "=== S4: Rapid Peer Churn ==="
echo "  Relays: $RELAY_COUNT (${PIN_COUNT} pinners)"
echo "  Stable writers: $WRITERS"
echo "  Baseline: ${BASELINE_S}s"
echo "  Churn: ${CHURN_S}s"
echo "  Recovery: ${RECOVERY_S}s"

# Start fleet
"$SCRIPT_DIR/chaos-fleet.sh" start "$RELAY_COUNT" \
  --base-port "$BASE_PORT" \
  --base-tcp-port "$BASE_TCP_PORT" \
  --pin-count "$PIN_COUNT" \
  --app-id "$APP_ID"

# Build bootstrap flags
BOOTSTRAPS=""
while IFS= read -r addr; do
  BOOTSTRAPS+=" --bootstrap $addr"
done < <("$SCRIPT_DIR/chaos-fleet.sh" bootstrap)

cleanup() {
  "$SCRIPT_DIR/chaos-fleet.sh" stop || true
}
trap cleanup EXIT

echo ""
echo "--- Phase 1: Baseline (no churn) ---"
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers 0 \
  --duration "$BASELINE_S" \
  --churn-interval 999999 \
  --churn-size 0 \
  --stabilize 0 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s4-baseline.jsonl" \
  $BOOTSTRAPS

echo ""
echo "--- Phase 2: Aggressive churn ---"
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers 0 \
  --duration "$CHURN_S" \
  --churn-interval 5000 \
  --churn-size 3 \
  --stabilize 2000 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s4-churn.jsonl" \
  $BOOTSTRAPS

echo ""
echo "--- Phase 3: Recovery (no churn) ---"
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers 0 \
  --duration "$RECOVERY_S" \
  --churn-interval 999999 \
  --churn-size 0 \
  --stabilize 0 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s4-recovery.jsonl" \
  $BOOTSTRAPS

echo ""
echo "=== S4: Analyzing results ==="

echo "--- Baseline ---"
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s4-baseline.jsonl" \
  --max-errors 5 \
  --ack-rate 80

echo ""
echo "--- Churn ---"
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s4-churn.jsonl" \
  --max-errors 20 \
  --ack-rate 30

echo ""
echo "--- Recovery ---"
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s4-recovery.jsonl" \
  --max-errors 5 \
  --ack-rate 80
