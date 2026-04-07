#!/usr/bin/env bash
set -euo pipefail

# Validate deploy/nodes.json structure.
#
# Usage:
#   bin/validate-nodes-config.sh [--require-roles]
#
# Checks:
#   - File exists and is valid JSON
#   - Has .defaults with required fields
#   - Has .batches array with at least one batch
#   - Each batch has .nodes array
#   - Each node has .name and .host strings
#   - With --require-roles: each node has .roles array
#
# Exits 0 on success, 1 with clear error on failure.

REQUIRE_ROLES=false
for arg in "$@"; do
  if [ "$arg" = "--require-roles" ]; then
    REQUIRE_ROLES=true
  fi
done

CONFIG="deploy/nodes.json"

# File exists
if [ ! -f "$CONFIG" ]; then
  echo "::error::$CONFIG not found." \
    "Is DEPLOY_NODES_CONFIG secret set?"
  exit 1
fi

# Valid JSON
if ! jq empty "$CONFIG" 2>/dev/null; then
  echo "::error::$CONFIG is not valid JSON"
  exit 1
fi

# Required defaults
DEFAULTS_FIELDS=(
  "user" "repo_path" "service"
  "health_port" "health_timeout"
  "health_retries" "health_retry_delay"
  "startup_wait"
)
for field in "${DEFAULTS_FIELDS[@]}"; do
  VAL=$(jq -r ".defaults.$field // empty" "$CONFIG")
  if [ -z "$VAL" ]; then
    echo "::error::Missing .defaults.$field" \
      "in DEPLOY_NODES_CONFIG"
    exit 1
  fi
done

# Batches array
BATCH_COUNT=$(jq '.batches | length' "$CONFIG")
if [ "$BATCH_COUNT" -lt 1 ]; then
  echo "::error::No batches in DEPLOY_NODES_CONFIG." \
    "Expected .batches array with at least one entry."
  exit 1
fi

# Validate each node
ERRORS=0
for b in $(seq 0 $((BATCH_COUNT - 1))); do
  NODE_COUNT=$(jq \
    --argjson idx "$b" \
    '.batches[$idx].nodes | length' "$CONFIG")

  if [ "$NODE_COUNT" -lt 1 ]; then
    echo "::error::Batch $((b+1)) has no nodes"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  for n in $(seq 0 $((NODE_COUNT - 1))); do
    NAME=$(jq -r \
      --argjson b "$b" --argjson n "$n" \
      '.batches[$b].nodes[$n].name // empty' \
      "$CONFIG")
    HOST=$(jq -r \
      --argjson b "$b" --argjson n "$n" \
      '.batches[$b].nodes[$n].host // empty' \
      "$CONFIG")

    if [ -z "$NAME" ]; then
      echo "::error::Batch $((b+1)) node $((n+1))" \
        "missing .name"
      ERRORS=$((ERRORS + 1))
    fi
    if [ -z "$HOST" ]; then
      echo "::error::Batch $((b+1)) node" \
        "${NAME:-$((n+1))} missing .host"
      ERRORS=$((ERRORS + 1))
    fi

    if [ "$REQUIRE_ROLES" = "true" ]; then
      HAS_ROLES=$(jq \
        --argjson b "$b" --argjson n "$n" \
        '.batches[$b].nodes[$n].roles
         | type == "array" and length > 0' \
        "$CONFIG")
      if [ "$HAS_ROLES" != "true" ]; then
        echo "::error::Node ${NAME:-$((n+1))}" \
          "missing .roles array." \
          "Add [\"relay\"] or" \
          "[\"relay\", \"pinner\"]."
        ERRORS=$((ERRORS + 1))
      fi
    fi
  done
done

if [ "$ERRORS" -gt 0 ]; then
  echo "::error::$ERRORS validation error(s)" \
    "in DEPLOY_NODES_CONFIG"
  exit 1
fi

# Summary
TOTAL_NODES=$(jq \
  '[.batches[].nodes[]] | length' "$CONFIG")
echo "Config valid: $BATCH_COUNT batch(es)," \
  "$TOTAL_NODES node(s)"

if [ "$REQUIRE_ROLES" = "true" ]; then
  PINNER_COUNT=$(jq \
    '[.batches[].nodes[]
      | select(.roles and
          (.roles | index("pinner")))]
     | length' "$CONFIG")
  echo "  Pinners: $PINNER_COUNT"
fi
