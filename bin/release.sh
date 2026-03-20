#!/usr/bin/env bash
set -euo pipefail

# Release automation wrapping @changesets/cli.
#
# Usage:
#   bin/release.sh
#   bin/release.sh --branch release/0.1.x
#
# Steps:
#   1. Verify branch and clean tree
#   2. npx changeset version
#   3. Show CHANGELOG diff, pause for review
#   4. npm install (sync lockfile)
#   5. Read core's new version from package.json
#   6. git add -A && git commit
#   7. git tag v<version>
#   8. Push commit + tag to Gitea and GitHub
#
# Sets POKAPALI_RELEASE=1 so the pre-commit hook
# allows commits on main/release/* while still
# running lint-staged formatting.

export POKAPALI_RELEASE=1

# --- Parse flags ---

ALLOWED_BRANCH="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      ALLOWED_BRANCH="$2"
      shift 2
      ;;
    *)
      echo "Usage: bin/release.sh [--branch <name>]"
      exit 1
      ;;
  esac
done

# --- 1. Verify preconditions ---

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "$ALLOWED_BRANCH" ]; then
  echo "ERROR: must be on $ALLOWED_BRANCH" \
    "(currently: $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree has uncommitted changes"
  git status --short
  exit 1
fi

echo "=== Release from $BRANCH ==="
echo "  tree: clean"

# --- 2. Run changeset version ---

echo ""
echo "=== Running changeset version ==="
npx changeset version

# Check that core's version actually changed
CORE_VERSION=$(node -p \
  "require('./packages/core/package.json').version")
if git diff --quiet -- packages/core/package.json; then
  echo ""
  echo "ERROR: changeset version made no changes to"
  echo "  packages/core/package.json."
  echo "  Are there any changeset files to consume?"
  echo ""
  echo "Restoring working tree..."
  git checkout -- .
  exit 1
fi

echo "  core version: $CORE_VERSION"

# --- 3. Show CHANGELOG diff for review ---

echo ""
echo "=== Changelog review ==="
echo ""
echo "The following CHANGELOG entries were generated."
echo "Review for technical accuracy and completeness."
echo ""
git diff -- '**/CHANGELOG.md'
echo ""
echo "==============================="
echo "Sign-offs needed:"
echo "  - architect (technical accuracy)"
echo "  - PM (completeness/clarity)"
echo ""
read -r -p "Approve and continue? [y/N] " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo ""
  echo "Aborted. Restoring working tree..."
  git checkout -- .
  git clean -fd .changeset/ 2>/dev/null || true
  exit 0
fi

# --- 4. Sync lockfile ---

echo ""
echo "=== Syncing lockfile ==="
npm install --ignore-scripts
echo "  lockfile updated"

# --- 5. Commit ---

echo ""
echo "=== Committing release ==="
git add -A
git commit -m "$(cat <<EOF
chore: release $CORE_VERSION

Computed by changeset version. Bumps changed packages,
updates CHANGELOG.md entries, and syncs lockfile.

Co-authored-by: g. nicholas d'andrea <nick@gnidan.org>
EOF
)"

echo "  committed: $(git rev-parse --short HEAD)"

# --- 6. Tag ---

TAG="v$CORE_VERSION"
git tag "$TAG"
echo "  tagged: $TAG"

# --- 7. Push ---

echo ""
echo "==============================="
echo "Release $CORE_VERSION ready to push."
echo ""
echo "  commit: $(git rev-parse --short HEAD)"
echo "  tag:    $TAG"
echo ""
echo "This will push to both origin (Gitea)"
echo "and github (GitHub). The push to main on"
echo "GitHub triggers publish.yml."
echo ""
read -r -p "Push? [y/N] " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo ""
  echo "Aborted. Commit and tag are local only."
  echo "To push later:"
  echo "  git push origin $ALLOWED_BRANCH"
  echo "  git push github $ALLOWED_BRANCH"
  echo "  git push github $TAG"
  exit 0
fi

echo ""
echo "=== Pushing to origin (Gitea) ==="
git push origin "$ALLOWED_BRANCH"

echo ""
echo "=== Pushing to github ==="
git push github "$ALLOWED_BRANCH"
git push github "$TAG"

echo ""
echo "=== Release $CORE_VERSION complete ==="
echo ""
echo "Next steps:"
echo "  1. Wait for publish.yml to go green"
echo "  2. Verify packages on npm"
echo "  3. Create GitHub release (manual)"
