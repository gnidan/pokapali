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
git fetch origin main
git reset --hard "$COMMIT"
npm install --no-audit --no-fund
npx tsc --build
sudo systemctl restart "$SERVICE"

echo "Deployed $(git rev-parse --short HEAD), service restarted."
REMOTE

echo "[$HOST] Deploy complete."
