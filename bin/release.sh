#!/usr/bin/env bash
set -euo pipefail

# Release automation: changelog + version bump + tag push.
#
# Orchestrates the full release chain mechanically,
# preventing the class of errors seen in every prior
# release (alpha.3: batch tag push, alpha.5: wrong
# tag format).
#
# Usage:
#   bin/release.sh <version>
#   bin/release.sh 0.1.0-alpha.6
#
# Steps:
#   1. Verify on main with clean tree
#   2. Check CHANGELOG.md has unreleased content
#   3. Commit CHANGELOG.md (if modified)
#   4. Run version-bump.mjs --all <version>
#   5. Squash changelog + bump into one commit
#   6. Validate tag format against publish.yml
#   7. Push commit to origin
#   8. Push tags individually (GHA limitation)
#
# Sets POKAPALI_RELEASE=1 so the pre-commit hook
# allows commits on main while still running
# lint-staged formatting.

export POKAPALI_RELEASE=1

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: bin/release.sh <version>"
  echo "Example: bin/release.sh 0.1.0-alpha.6"
  exit 1
fi

# Basic version format check
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "ERROR: '$VERSION' doesn't look like a version"
  exit 1
fi

echo "=== Release $VERSION ==="
echo ""

# --- 1. Verify preconditions ---

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "ERROR: must be on main (currently: $BRANCH)"
  exit 1
fi

# Allow CHANGELOG.md to be modified, nothing else
CHANGELOG_DIRTY=false
if ! git diff --quiet -- CHANGELOG.md 2>/dev/null; then
  CHANGELOG_DIRTY=true
fi

OTHER_DIRTY=$(git diff --name-only | grep -v '^CHANGELOG.md$' || true)
STAGED=$(git diff --cached --name-only || true)

if [ -n "$OTHER_DIRTY" ] || [ -n "$STAGED" ]; then
  echo "ERROR: working tree has uncommitted changes"
  echo "(only CHANGELOG.md modifications are allowed)"
  echo ""
  git status --short
  exit 1
fi

echo "  branch: main"
echo "  tree: clean"

# --- 2. Check CHANGELOG.md has unreleased content ---

if ! grep -q '## \[Unreleased\]' CHANGELOG.md; then
  echo ""
  echo "ERROR: CHANGELOG.md has no [Unreleased] section"
  exit 1
fi

# Extract content between [Unreleased] and next ## heading
UNRELEASED=$(sed -n '/^## \[Unreleased\]/,/^## \[/{/^## \[/d;p;}' \
  CHANGELOG.md | grep -cE '^### ' || true)

if [ "$UNRELEASED" -eq 0 ]; then
  echo ""
  echo "ERROR: CHANGELOG.md [Unreleased] section is empty"
  echo "Add release notes before running release.sh."
  exit 1
fi

echo "  changelog: has unreleased content"

# --- 3. Commit CHANGELOG.md if modified ---

COMMITS_TO_SQUASH=0

if [ "$CHANGELOG_DIRTY" = true ]; then
  echo ""
  echo "=== Committing CHANGELOG.md ==="
  git add CHANGELOG.md
  git commit -m "docs: update changelog for $VERSION"
  COMMITS_TO_SQUASH=1
  echo "  committed changelog"
fi

# --- 4. Run version-bump.mjs ---

echo ""
echo "=== Running version-bump.mjs --all $VERSION ==="

# version-bump.mjs checks main + clean tree internally,
# creates commit + tags
node bin/version-bump.mjs --all "$VERSION"

COMMITS_TO_SQUASH=$((COMMITS_TO_SQUASH + 1))

# --- 5. Squash into single release commit ---

if [ "$COMMITS_TO_SQUASH" -eq 2 ]; then
  echo ""
  echo "=== Squashing changelog + bump commits ==="

  # Collect tags before squash (they point at old HEAD)
  TAGS=()
  while IFS= read -r tag; do
    TAGS+=("$tag")
  done < <(git tag --points-at HEAD)

  # Delete tags (they point at the pre-squash commit)
  for tag in "${TAGS[@]}"; do
    git tag -d "$tag" >/dev/null
  done

  # Squash: soft reset 2 commits, recommit
  git reset --soft HEAD~2
  git commit -m "$(cat <<EOF
chore: release $VERSION

Updates CHANGELOG.md and bumps all packages to $VERSION.
EOF
  )"

  # Recreate tags on squashed commit
  for tag in "${TAGS[@]}"; do
    git tag "$tag"
  done

  echo "  squashed into single commit: $(git rev-parse --short HEAD)"
fi

# --- 6. Validate tag format ---

echo ""
echo "=== Validating tags ==="

TAGS=()
while IFS= read -r tag; do
  TAGS+=("$tag")
done < <(git tag --points-at HEAD)

if [ ${#TAGS[@]} -eq 0 ]; then
  echo "ERROR: no tags on HEAD — version-bump.mjs"
  echo "may have failed silently"
  exit 1
fi

TAG_ERRORS=0
for tag in "${TAGS[@]}"; do
  # Must match publish/<dir>/<version>
  # Must NOT be publish/packages/<dir>/... (alpha.5 bug)
  if ! echo "$tag" | grep -qE '^publish/[a-z-]+/[0-9]'; then
    echo "  INVALID: $tag"
    echo "    Expected: publish/<dir>/<version>"
    TAG_ERRORS=$((TAG_ERRORS + 1))
  elif echo "$tag" | grep -q '^publish/packages/'; then
    echo "  INVALID: $tag (contains packages/ prefix)"
    echo "    Should be: ${tag/packages\//}"
    TAG_ERRORS=$((TAG_ERRORS + 1))
  else
    echo "  OK: $tag"
  fi
done

if [ "$TAG_ERRORS" -gt 0 ]; then
  echo ""
  echo "ERROR: $TAG_ERRORS invalid tag(s). Aborting push."
  echo "Fix tags manually, then re-run or push by hand."
  exit 1
fi

echo ""
echo "  ${#TAGS[@]} tags validated"

# --- 7. Summary and confirmation ---

echo ""
echo "==============================="
echo "Release $VERSION ready to push."
echo ""
echo "  commit: $(git rev-parse --short HEAD)"
echo "  tags:   ${#TAGS[@]}"
echo ""
echo "This will:"
echo "  1. Push commit to origin/main"
echo "  2. Push ${#TAGS[@]} tags individually"
echo "     (each triggers a publish workflow)"
echo ""
read -r -p "Proceed? [y/N] " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo ""
  echo "Aborted. Commit and tags are local only."
  echo "To undo: git reset --hard HEAD~1"
  echo "         git tag -d publish/..."
  exit 0
fi

# --- 8. Push commit ---

echo ""
echo "=== Pushing commit ==="
git push origin main

# --- 9. Push tags individually ---
# GHA limitation: multiple tags in one push only
# triggers one workflow run.

echo ""
echo "=== Pushing tags (one at a time) ==="

PUSH_ERRORS=0
for tag in "${TAGS[@]}"; do
  echo -n "  $tag ... "
  if git push origin "$tag" 2>/dev/null; then
    echo "done"
  else
    echo "FAILED"
    PUSH_ERRORS=$((PUSH_ERRORS + 1))
  fi
done

echo ""
if [ "$PUSH_ERRORS" -gt 0 ]; then
  echo "WARNING: $PUSH_ERRORS tag(s) failed to push."
  echo "Push remaining manually or use workflow_dispatch."
else
  echo "All ${#TAGS[@]} tags pushed successfully."
fi

echo ""
echo "=== Release $VERSION complete ==="
echo ""
echo "Monitor publish workflows:"
echo "  gh run list --workflow=publish.yml --limit=${#TAGS[@]}"
