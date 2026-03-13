#!/usr/bin/env bash
set -euo pipefail

# Merge a branch to main with pre-merge verification.
#
# Usage:
#   bin/merge-branch.sh <branch>
#
# Steps:
#   1. Merges main into the branch (in its worktree
#      or via checkout) so it has latest tools + code
#   2. Runs bin/verify-branch.sh on the merged state
#   3. If clean, merges the branch to main
#
# This verifies the actual post-merge state, catching
# integration issues and merge conflicts early.
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

# Merge main into the branch and verify, either in
# its worktree or via temporary checkout.
verify_in_worktree() {
  local dir="$1"
  echo "  (worktree: $dir)"

  echo ""
  echo "=== Merging main into '$BRANCH' ==="
  if ! (cd "$dir" && git merge main); then
    echo ""
    echo "Merge main into '$BRANCH' FAILED."
    echo "Resolve conflicts in $dir, then retry."
    exit 1
  fi

  echo ""
  echo "=== Verifying branch '$BRANCH' ==="
  if ! (cd "$dir" && bin/verify-branch.sh); then
    echo ""
    echo "Verification FAILED. Not merging."
    exit 1
  fi
}

verify_via_checkout() {
  echo "  (no worktree found, checking out)"
  git checkout "$BRANCH"

  echo ""
  echo "=== Merging main into '$BRANCH' ==="
  if ! git merge main; then
    echo ""
    echo "Merge main into '$BRANCH' FAILED."
    echo "Resolve conflicts, then retry."
    git checkout main
    exit 1
  fi

  echo ""
  echo "=== Verifying branch '$BRANCH' ==="
  if ! bin/verify-branch.sh; then
    echo ""
    echo "Verification FAILED. Not merging."
    git checkout main
    exit 1
  fi

  git checkout main
}

echo "=== Preparing branch '$BRANCH' ==="

WORKTREE_DIR=""
if WORKTREE_DIR=$(find_worktree "$BRANCH"); then
  verify_in_worktree "$WORKTREE_DIR"
else
  verify_via_checkout
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
