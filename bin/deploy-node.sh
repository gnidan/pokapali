#!/usr/bin/env bash
set -euo pipefail

# Deploy a single node: pull, build, restart.
#
# Usage:
#   bin/deploy-node.sh <user> <host> <repo_path> \
#     <service> <commit>
#
# Requires SSH access to <user>@<host>.

USER="$1"
HOST="$2"
REPO_PATH="$3"
SERVICE="$4"
COMMIT="$5"

echo "[$HOST] Deploying commit ${COMMIT:0:7}..."

ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
  "$USER@$HOST" bash -s -- "$REPO_PATH" "$SERVICE" "$COMMIT" <<'REMOTE'
set -euo pipefail
REPO_PATH="$1"
SERVICE="$2"
COMMIT="$3"

cd "$REPO_PATH"

# Log relay storage state for deploy diagnostics.
# Storage path lives outside the repo (e.g.
# /var/lib/pokapali-node/) so git reset --hard
# does not affect it.
UNIT_FILE=$(systemctl show -p FragmentPath \
  "$SERVICE" 2>/dev/null \
  | sed 's/FragmentPath=//')
if [ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ]; then
  STORAGE=$(grep -oP '(?<=--storage-path\s)\S+' \
    "$UNIT_FILE" 2>/dev/null || true)
  if [ -n "$STORAGE" ]; then
    echo "Storage: $STORAGE"
    [ -f "$STORAGE/relay-key.bin" ] \
      && echo "  relay-key.bin: ok" \
      || echo "  relay-key.bin: MISSING"
    [ -d "$STORAGE/datastore" ] \
      && echo "  datastore/: ok" \
      || echo "  datastore/: MISSING"
  fi
fi

git fetch origin main
git reset --hard "$COMMIT"
npm install --no-audit --no-fund
npm run build -w @pokapali/node
sudo systemctl restart "$SERVICE"

echo "Deployed $(git rev-parse --short HEAD), service restarted."
REMOTE

echo "[$HOST] Deploy complete."
