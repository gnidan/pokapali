#!/usr/bin/env bash
set -euo pipefail

# Verify that the example app builds against published
# @pokapali/* packages (not workspace-linked source).
#
# Creates an isolated temp directory, copies the example
# app source, installs published deps from npm, and runs
# a production build. Catches missing exports, type
# mismatches, and other publish-time regressions.
#
# Usage:
#   bin/verify-published-deps.sh
#   bin/verify-published-deps.sh --keep  # keep temp dir

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE_DIR="$REPO_ROOT/apps/example"
KEEP=false

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

TMPDIR="$(mktemp -d)"
cleanup() {
  if [ "$KEEP" = true ]; then
    echo "Temp dir kept at: $TMPDIR"
  else
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

echo "==> Copying example app to $TMPDIR"

# Copy source files needed for build
cp "$EXAMPLE_DIR/package.json" "$TMPDIR/"
cp "$EXAMPLE_DIR/tsconfig.json" "$TMPDIR/"
cp "$EXAMPLE_DIR/vite.config.ts" "$TMPDIR/"
cp "$EXAMPLE_DIR/index.html" "$TMPDIR/"
cp -r "$EXAMPLE_DIR/src" "$TMPDIR/src"
cp -r "$EXAMPLE_DIR/public" "$TMPDIR/public" 2>/dev/null || true

# tsconfig references the base config — provide a
# minimal standalone version instead.
cat > "$TMPDIR/tsconfig.json" <<'TSEOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
TSEOF

echo "==> Installing published packages"
cd "$TMPDIR"
npm install --ignore-scripts 2>&1

echo "==> Building with published deps"
POKAPALI_PUBLISHED_DEPS=1 npx vite build 2>&1

echo ""
echo "==> Build succeeded with published packages"
ls -lh "$TMPDIR/dist/assets/" 2>/dev/null || true
