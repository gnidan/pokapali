#!/usr/bin/env bash
set -euo pipefail

# Merge a branch to main with pre-merge verification.
#
# Usage:
#   bin/merge-branch.sh <branch>
#
# Steps:
#   1. Checks out the source branch
#   2. Runs bin/verify-branch.sh
#   3. Returns to main
#   4. Merges the branch (no-ff for clear history)
#
# Aborts if verification fails or merge conflicts.

BRANCH="${1:-}"

if [ -z "$BRANCH" ]; then
  echo "Usage: bin/merge-branch.sh <branch>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "main" ]; then
  echo "ERROR: must be on main branch (currently: $CURRENT)"
  exit 1
fi

# Ensure working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree has uncommitted changes"
  exit 1
fi

echo "=== Verifying branch '$BRANCH' ==="

git checkout "$BRANCH"

if ! bin/verify-branch.sh; then
  echo ""
  echo "Verification FAILED. Not merging."
  git checkout main
  exit 1
fi

echo ""
echo "=== Verification passed. Merging to main ==="

git checkout main

if git merge "$BRANCH"; then
  echo ""
  echo "Merged '$BRANCH' to main successfully."
  echo "  tip: $(git rev-parse --short HEAD)"
  echo ""
  echo "NOTE: not pushed. Run 'git push' when ready."
else
  echo ""
  echo "Merge FAILED (likely conflicts)."
  echo "Run 'git merge --abort' to undo,"
  echo "  or resolve conflicts manually."
  exit 1
fi
