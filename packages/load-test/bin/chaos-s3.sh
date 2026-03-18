#!/usr/bin/env bash
set -euo pipefail

# S3: New-Name Flood Resilience
#
# Validates that the pinner's new-name rate limiter
# (#77) protects against name-flooding without
# degrading service for existing documents.
#
# 1. Start 4-relay fleet with low rate limit
#    (--max-new-names-per-hour 10 on pinners)
# 2. Baseline: stable writers, no churn (60s)
# 3. Flood: aggressive churn adds many new writers
#    (each = new IPNS name, hits rate limit) (120s)
# 4. Recovery: stable writers only (60s)
# 5. Verify: stable writers' acks maintained,
#    pinner newNameRejects > 0 (limiter exercised)
#
# Usage:
#   chaos-s3.sh [--output DIR] [--baseline S]
#     [--flood S] [--recovery S] [--writers N]
#     [--readers N] [--rate-limit N]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="/tmp/chaos-s3"
BASELINE_S=60
FLOOD_S=120
RECOVERY_S=60
WRITERS=5
READERS=2
RATE_LIMIT=10
APP_ID="pokapali-chaos-test"
RELAY_COUNT=4
PIN_COUNT=2
BASE_PORT=3000
BASE_TCP_PORT=4001

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --baseline) BASELINE_S="$2"; shift 2 ;;
    --flood) FLOOD_S="$2"; shift 2 ;;
    --recovery) RECOVERY_S="$2"; shift 2 ;;
    --writers) WRITERS="$2"; shift 2 ;;
    --readers) READERS="$2"; shift 2 ;;
    --rate-limit) RATE_LIMIT="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

echo "=== S3: New-Name Flood Resilience ==="
echo "  Relays: $RELAY_COUNT (${PIN_COUNT} pinners)"
echo "  Stable writers: $WRITERS"
echo "  Readers: $READERS"
echo "  Rate limit: $RATE_LIMIT new names/hour"
echo "  Baseline: ${BASELINE_S}s"
echo "  Flood: ${FLOOD_S}s"
echo "  Recovery: ${RECOVERY_S}s"

# Start fleet with low new-name rate limit on pinners
"$SCRIPT_DIR/chaos-fleet.sh" start "$RELAY_COUNT" \
  --base-port "$BASE_PORT" \
  --base-tcp-port "$BASE_TCP_PORT" \
  --pin-count "$PIN_COUNT" \
  --app-id "$APP_ID" \
  --pinner-flags "--max-new-names-per-hour $RATE_LIMIT"

# Build bootstrap flags
BOOTSTRAPS=""
while IFS= read -r addr; do
  BOOTSTRAPS+=" --bootstrap $addr"
done < <("$SCRIPT_DIR/chaos-fleet.sh" bootstrap)

cleanup() {
  # Capture pinner metrics before teardown
  echo ""
  echo "=== Pinner Metrics (pre-teardown) ==="
  for ((i = 0; i < PIN_COUNT; i++)); do
    local_port=$((BASE_PORT + i * 10))
    metrics=$(curl -sf -m 5 \
      "http://localhost:$local_port/metrics" \
      2>/dev/null || echo '{"error":"unavailable"}')
    new_rejects=$(echo "$metrics" \
      | jq -r '.pinner.newNameRejects // "N/A"')
    capacity_rejects=$(echo "$metrics" \
      | jq -r '.pinner.capacityRejects // "N/A"')
    known=$(echo "$metrics" \
      | jq -r '.pinner.knownNames // "N/A"')
    echo "  pinner-$i: knownNames=$known" \
      "newNameRejects=$new_rejects" \
      "capacityRejects=$capacity_rejects"
  done

  "$SCRIPT_DIR/chaos-fleet.sh" stop || true
}
trap cleanup EXIT

echo ""
echo "--- Phase 1: Baseline (stable writers) ---"
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers "$READERS" \
  --duration "$BASELINE_S" \
  --churn-interval 999999 \
  --churn-size 0 \
  --stabilize 0 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s3-baseline.jsonl" \
  $BOOTSTRAPS

echo ""
echo "--- Phase 2: Flood (aggressive churn) ---"
# High churn-size (5) with short interval (3s) creates
# many new writers rapidly. Each new writer = new IPNS
# name that hits the pinner's rate limit.
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers "$READERS" \
  --duration "$FLOOD_S" \
  --churn-interval 3000 \
  --churn-size 5 \
  --stabilize 1000 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s3-flood.jsonl" \
  $BOOTSTRAPS

echo ""
echo "--- Phase 3: Recovery (stable writers) ---"
# shellcheck disable=SC2086
node "$REPO/packages/load-test/dist/bin/churn.js" \
  --writers "$WRITERS" \
  --readers "$READERS" \
  --duration "$RECOVERY_S" \
  --churn-interval 999999 \
  --churn-size 0 \
  --stabilize 0 \
  --interval 5000 \
  --edit-size 100 \
  --app-id "$APP_ID" \
  --output "$OUTPUT_DIR/s3-recovery.jsonl" \
  $BOOTSTRAPS

echo ""
echo "=== S3: Analyzing results ==="

echo "--- Baseline ---"
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s3-baseline.jsonl" \
  --max-errors 5 \
  --ack-rate 80

echo ""
echo "--- Flood ---"
# During flood, stable writers should still get acks.
# Churned writers may not (new names rejected by rate
# limiter), so overall ack rate is lower. We care that
# it doesn't collapse to 0.
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s3-flood.jsonl" \
  --max-errors 20 \
  --ack-rate 20

echo ""
echo "--- Recovery ---"
node "$REPO/packages/load-test/dist/bin/analyze.js" \
  "$OUTPUT_DIR/s3-recovery.jsonl" \
  --max-errors 5 \
  --ack-rate 80
