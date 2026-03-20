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
#   2. Capture internal changeset entries
#   3. npx changeset version
#   4. Inject internal entries into root CHANGELOG.md
#   5. Show CHANGELOG diff, pause for review
#   6. npm install (sync lockfile)
#   7. git add -A && git commit
#   8. Push commit to Gitea and GitHub
#
# Per-package tags (@pokapali/pkg@ver) are created
# by `changeset publish` in GHA, not by this script.
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

# --- 2. Capture internal changeset entries ---
#
# Changesets with empty frontmatter (no package refs)
# describe internal work (CI, docs, scripts). These
# are consumed by `changeset version` but don't
# appear in any per-package CHANGELOG. We capture
# them here and inject into the root CHANGELOG.md.

INTERNAL_ENTRIES=""
for cs in .changeset/*.md; do
  [ -f "$cs" ] || continue
  [ "$(basename "$cs")" = "README.md" ] && continue

  # Parse frontmatter (between the two --- markers)
  FRONT=$(awk \
    'BEGIN{n=0} /^---$/{n++;next} n==1{print}' \
    "$cs")

  # If frontmatter is empty (no package refs),
  # capture the body as an internal entry
  if [ -z "$(echo "$FRONT" | tr -d '[:space:]')" ]
  then
    BODY=$(awk \
      'BEGIN{n=0} /^---$/{n++;next} n>=2' \
      "$cs" | sed '/^$/d')
    if [ -n "$BODY" ]; then
      # Format each entry as a list item
      FIRST_LINE=$(echo "$BODY" | head -1)
      REST=$(echo "$BODY" | tail -n +2)
      ENTRY="- $FIRST_LINE"
      if [ -n "$REST" ]; then
        ENTRY="$ENTRY
$(echo "$REST" | awk '{print "  " $0}')"
      fi
      if [ -n "$INTERNAL_ENTRIES" ]; then
        INTERNAL_ENTRIES="$INTERNAL_ENTRIES
$ENTRY"
      else
        INTERNAL_ENTRIES="$ENTRY"
      fi
    fi
  fi
done

if [ -n "$INTERNAL_ENTRIES" ]; then
  echo "  internal entries: $(echo \
    "$INTERNAL_ENTRIES" | grep -c '^-')"
fi

# --- 3. Run changeset version ---

echo ""
echo "=== Running changeset version ==="
npx changeset version

# Collect bumped package versions for commit message
BUMPED=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const dirs = [
    ...fs.readdirSync('packages').map(d =>
      'packages/' + d),
    ...fs.readdirSync('apps').map(d =>
      'apps/' + d)
  ];
  for (const dir of dirs) {
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) continue;
    try {
      const out = require('child_process')
        .execSync('git diff -- ' + p,
          { encoding: 'utf8' });
      if (!out) continue;
      const pkg = JSON.parse(
        fs.readFileSync(p, 'utf8'));
      console.log(pkg.name + '@' + pkg.version);
    } catch {}
  }
")
RELEASE_DATE=$(date +%Y-%m-%d)

# Check that something actually changed — either
# packages were bumped or internal entries exist
HAS_PKG_CHANGES=0
if ! git diff --quiet -- 'packages/*/package.json' \
  'apps/*/package.json' 2>/dev/null; then
  HAS_PKG_CHANGES=1
fi

if [ "$HAS_PKG_CHANGES" -eq 0 ] \
  && [ -z "$INTERNAL_ENTRIES" ]; then
  echo ""
  echo "ERROR: changeset version made no changes"
  echo "  and no internal entries found."
  echo "  Are there any changeset files to consume?"
  echo ""
  echo "Restoring working tree..."
  git checkout -- .
  exit 1
fi

echo "  date: $RELEASE_DATE"
if [ -n "$BUMPED" ]; then
  echo "  bumped:"
  echo "$BUMPED" | while read -r line; do
    echo "    $line"
  done
else
  echo "  package changes: no (internal only)"
fi

# --- 4. Inject internal entries into CHANGELOG ---

if [ -n "$INTERNAL_ENTRIES" ]; then
  echo ""
  echo "=== Injecting internal entries ==="

  node -e "
    const fs = require('fs');
    const date = process.argv[1];
    const entries = process.argv[2];
    const file = 'CHANGELOG.md';

    let cl = fs.readFileSync(file, 'utf8');
    const heading = '## ' + date;
    const section = '### Internal\n\n' + entries;

    // Guard against duplicate injection
    if (cl.includes(heading + '\n')) {
      if (!cl.includes('### Internal')) {
        cl = cl.replace(
          heading,
          heading + '\n\n' + section
        );
      }
    } else {
      cl = cl.replace(
        '## [Unreleased]',
        '## [Unreleased]\n\n'
          + heading + '\n\n' + section
      );
    }
    fs.writeFileSync(file, cl);
  " "$RELEASE_DATE" "$INTERNAL_ENTRIES"

  echo "  injected $(echo "$INTERNAL_ENTRIES" \
    | grep -c '^-') entries into CHANGELOG.md"
fi

# --- 5. Show CHANGELOG diff for review ---

echo ""
echo "=== Changelog review ==="
echo ""
echo "The following CHANGELOG entries were generated."
echo "Review for technical accuracy and completeness."
echo ""
# Stage CHANGELOGs so new files show in diff
git add '**/CHANGELOG.md' CHANGELOG.md 2>/dev/null \
  || true
git diff --cached -- '**/CHANGELOG.md' CHANGELOG.md
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
  git reset HEAD -- . 2>/dev/null || true
  git checkout -- .
  git clean -fd .changeset/ 2>/dev/null || true
  exit 0
fi

# --- 6. Sync lockfile ---

echo ""
echo "=== Syncing lockfile ==="
npm install --ignore-scripts
echo "  lockfile updated"

# --- 7. Commit ---

echo ""
echo "=== Committing release ==="
git add -A
COMMIT_MSG="chore: release $RELEASE_DATE

Computed by changeset version. Bumps changed packages,
updates CHANGELOG.md entries, and syncs lockfile.

Co-authored-by: g. nicholas d'andrea <nick@gnidan.org>"
git commit -m "$COMMIT_MSG"

echo "  committed: $(git rev-parse --short HEAD)"

# --- 8. Push ---
#
# Per-package tags are created by `changeset publish`
# in GHA after this push triggers publish.yml.

echo ""
echo "==============================="
echo "Release $RELEASE_DATE ready to push."
echo ""
echo "  commit: $(git rev-parse --short HEAD)"
if [ -n "$BUMPED" ]; then
  echo "  packages:"
  echo "$BUMPED" | while read -r line; do
    echo "    $line"
  done
fi
echo ""
echo "This will push to both origin (Gitea)"
echo "and github (GitHub). The push to main on"
echo "GitHub triggers publish.yml, which creates"
echo "per-package git tags after publishing."
echo ""
read -r -p "Push? [y/N] " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo ""
  echo "Aborted. Commit is local only."
  echo "To push later:"
  echo "  git push origin $ALLOWED_BRANCH"
  echo "  git push github $ALLOWED_BRANCH"
  exit 0
fi

echo ""
echo "=== Pushing to origin (Gitea) ==="
git push origin "$ALLOWED_BRANCH"

echo ""
echo "=== Pushing to github ==="
git push github "$ALLOWED_BRANCH"

echo ""
echo "=== Release $RELEASE_DATE complete ==="
echo ""
echo "Next steps:"
echo "  1. Wait for publish.yml to go green"
echo "  2. Verify packages on npm"
echo "  3. Create GitHub release (manual)"
