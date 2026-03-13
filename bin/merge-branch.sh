#!/usr/bin/env bash
set -euo pipefail

# Merge a branch to main with pre-merge verification.
#
# Usage:
#   bin/merge-branch.sh <branch>
#
# Steps:
#   1. Finds the branch's worktree (or checks it out)
#   2. Runs bin/verify-branch.sh in that directory
#   3. Merges the branch to main
#
# Works with worktree-based workflows: if the branch
# is checked out in a worktree, verification runs
# there without needing to check it out again.
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
  echo "ERROR: must be on main branch" \
    "(currently: $CURRENT)"
  exit 1
fi

# Ensure working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet
then
  echo "ERROR: working tree has uncommitted changes"
  exit 1
fi

# Find worktree for the branch, if any.
find_worktree() {
  local target="refs/heads/$1"
  local wt_path=""
  local wt_branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        wt_path="${line#worktree }"
        ;;
      "branch "*)
        wt_branch="${line#branch }"
        if [ "$wt_branch" = "$target" ]; then
          echo "$wt_path"
          return 0
        fi
        ;;
      "")
        wt_path=""
        wt_branch=""
        ;;
    esac
  done < <(git worktree list --porcelain)
  return 1
}

echo "=== Verifying branch '$BRANCH' ==="

WORKTREE_DIR=""
if WORKTREE_DIR=$(find_worktree "$BRANCH"); then
  echo "  (running in worktree: $WORKTREE_DIR)"
  if ! (cd "$WORKTREE_DIR" && bin/verify-branch.sh)
  then
    echo ""
    echo "Verification FAILED. Not merging."
    exit 1
  fi
else
  # Branch not in a worktree — check it out temporarily
  echo "  (no worktree found, checking out)"
  git checkout "$BRANCH"
  if ! bin/verify-branch.sh; then
    echo ""
    echo "Verification FAILED. Not merging."
    git checkout main
    exit 1
  fi
  git checkout main
fi

echo ""
echo "=== Verification passed. Merging to main ==="

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
