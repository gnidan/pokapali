#!/usr/bin/env bash
set -euo pipefail

# Pre-merge verification: build, test, format, lint.
#
# Run this BEFORE requesting a merge to main.
# Exits 0 if all checks pass, 1 on first failure.
#
# Usage:
#   bin/verify-branch.sh          # run all checks
#   bin/verify-branch.sh --quick  # build + format only

QUICK=false
if [ "${1:-}" = "--quick" ]; then
  QUICK=true
fi

PASS=0
FAIL=0
SKIP=0
ERRORS=""

step() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if "$@"; then
    echo "--- $label: PASS ---"
    PASS=$((PASS + 1))
  else
    echo "--- $label: FAIL ---"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS  - $label\n"
  fi
}

# Run a step only if the command exists; skip with
# a warning otherwise.
optional_step() {
  local label="$1"
  local cmd="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo ""
    echo "=== $label ==="
    echo "--- $label: SKIP ($cmd not found) ---"
    SKIP=$((SKIP + 1))
    return
  fi
  shift 2
  step "$label" "$cmd" "$@"
}

echo "verify-branch: starting pre-merge checks..."
echo "  branch: $(git branch --show-current)"
echo "  commit: $(git rev-parse --short HEAD)"

# Policy checks (always run, even with --quick)
# shellcheck disable=SC2016
step "No hardcoded IPs" bash -c '
  hits=$(grep -rEn "\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b" \
    packages/ .github/workflows/ \
    --include="*.ts" --include="*.yml" --include="*.yaml" \
    2>/dev/null \
    | grep -v "node_modules\|/dist/" \
    | grep -v "\.test\.ts:" \
    | grep -v "127\.0\.0\.1\|0\.0\.0\.0" \
    || true)
  if [ -n "$hits" ]; then
    echo "Found hardcoded IP addresses:"
    echo "$hits"
    echo ""
    echo "Use secrets or config, not hardcoded IPs."
    exit 1
  fi
'

# shellcheck disable=SC2016
step "No ignored files tracked" bash -c '
  tracked=$(git ls-files -- docs/plans/ 2>/dev/null || true)
  if [ -n "$tracked" ]; then
    echo "Files under docs/plans/ are tracked but"
    echo "should not be in source control:"
    echo "$tracked"
    echo ""
    echo "Remove with: git rm --cached <file>"
    exit 1
  fi
'

step "TypeScript build" npx tsc --build

step "Format check" npm run format:check

if [ "$QUICK" = false ]; then
  step "Tests" npm test

  step "Lint" npm run lint

  optional_step "Shell lint" shellcheck \
    bin/deploy-node.sh bin/deploy-setup.sh \
    bin/health-check.sh bin/verify-branch.sh

  optional_step "Workflow lint" actionlint
fi

echo ""
echo "==============================="
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED ($FAIL failed, $PASS passed)"
  echo ""
  echo "Failures:"
  echo -e "$ERRORS"
  echo "Fix these before requesting merge."
  exit 1
else
  if [ "$SKIP" -gt 0 ]; then
    echo "ALL PASSED ($PASS passed, $SKIP skipped)"
  else
    echo "ALL PASSED ($PASS checks)"
  fi
  echo ""
  echo "Branch is ready for merge review."
fi
