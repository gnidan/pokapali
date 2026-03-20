#!/usr/bin/env bash
set -euo pipefail

# Post-release verification: poll npm for published
# packages and check versions + dist-tags.
#
# Reads the list of expected packages from the most
# recent release commit or from explicit arguments.
#
# Usage:
#   bin/verify-release.sh
#   bin/verify-release.sh @pokapali/react@0.1.2
#   bin/verify-release.sh --timeout 180

TIMEOUT=120
POLL_INTERVAL=10
PACKAGES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bin/verify-release.sh" \
        "[--timeout <secs>] [pkg@ver ...]"
      exit 0
      ;;
    *) PACKAGES+=("$1"); shift ;;
  esac
done

# If no packages given, detect from recent commit
if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "==> Detecting packages from git..."

  # Look at package.json files changed in HEAD
  for dir in packages/*/; do
    [ -f "$dir/package.json" ] || continue
    DIFF=$(git diff HEAD~1 -- "$dir/package.json" \
      2>/dev/null || true)
    if [ -n "$DIFF" ]; then
      PKG=$(node -e "
        const p = require('./$dir/package.json');
        console.log(p.name + '@' + p.version);
      ")
      PACKAGES+=("$PKG")
    fi
  done

  if [ ${#PACKAGES[@]} -eq 0 ]; then
    echo "No package changes found in HEAD commit."
    echo "Pass packages explicitly:"
    echo "  bin/verify-release.sh @pokapali/react@0.1.2"
    exit 1
  fi
fi

echo "==> Verifying ${#PACKAGES[@]} package(s)"
echo "    timeout: ${TIMEOUT}s"
echo ""

FAIL=0
MAX_ATTEMPTS=$(( TIMEOUT / POLL_INTERVAL ))

for entry in "${PACKAGES[@]}"; do
  # Split @scope/name@version — last @ separates
  VER="${entry##*@}"
  PKG="${entry%@"$VER"}"

  echo "--- $PKG@$VER ---"

  # Poll npm until version appears
  FOUND=0
  for i in $(seq 1 "$MAX_ATTEMPTS"); do
    ACTUAL=$(npm view "$PKG" version \
      2>/dev/null || true)
    if [ "$ACTUAL" = "$VER" ]; then
      FOUND=1
      break
    fi
    echo "  poll $i/$MAX_ATTEMPTS: got '$ACTUAL'," \
      "want '$VER'"
    sleep "$POLL_INTERVAL"
  done

  if [ "$FOUND" -ne 1 ]; then
    echo "  FAIL: $PKG@$VER not found on npm"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Verify dist-tag
  TAGS=$(npm view "$PKG" dist-tags \
    --json 2>/dev/null || echo "{}")

  case "$VER" in
    *-*) EXPECTED_TAG="next" ;;
    *)   EXPECTED_TAG="latest" ;;
  esac

  TAG_VER=$(echo "$TAGS" \
    | node -e "
      const d = require('fs')
        .readFileSync(0,'utf8');
      const t = JSON.parse(d);
      console.log(t['$EXPECTED_TAG']||'')
    ")

  if [ "$TAG_VER" = "$VER" ]; then
    echo "  OK: $PKG@$VER ($EXPECTED_TAG)"
  else
    echo "  FAIL: $PKG@$VER expected" \
      "dist-tag '$EXPECTED_TAG' but got" \
      "'$TAG_VER'"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED: $FAIL package(s) did not verify"
  exit 1
fi
echo "All packages verified"
