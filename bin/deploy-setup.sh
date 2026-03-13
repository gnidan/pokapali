#!/usr/bin/env bash
set -euo pipefail

# Set up GH secrets for relay deployment.
#
# Usage:
#   bin/deploy-setup.sh
#
# Prerequisites:
#   - gh CLI authenticated
#   - SSH access to all relay nodes
#
# This script:
#   1. Generates an ed25519 deploy key (if needed)
#   2. Installs the public key on all relay nodes
#   3. Collects SSH host fingerprints
#   4. Sets GH secrets: DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$ROOT_DIR/deploy/nodes.json"
KEY_FILE="$ROOT_DIR/deploy/.deploy-key"

if [ ! -f "$CONFIG" ]; then
  echo "Error: $CONFIG not found"
  exit 1
fi

# --- Step 1: Generate deploy key ---

if [ -f "$KEY_FILE" ]; then
  echo "Deploy key already exists at $KEY_FILE"
  echo "Delete it to regenerate."
else
  echo "Generating ed25519 deploy key..."
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" \
    -C "github-actions-deploy"
  echo "Key generated: $KEY_FILE"
fi

PUB_KEY=$(cat "${KEY_FILE}.pub")

# --- Step 2: Install public key on nodes ---

echo ""
echo "Installing public key on relay nodes..."

HOSTS=$(jq -r '.batches[].nodes[] |
  "\(.name) \(.host)"' "$CONFIG")

while IFS=' ' read -r NAME HOST; do
  echo -n "  $NAME ($HOST)... "

  # Read defaults
  USER=$(jq -r '.defaults.user' "$CONFIG")

  # Check if key already installed
  # -n prevents SSH from consuming the while loop's stdin
  INSTALLED=$(ssh -n -o ConnectTimeout=15 \
    "$USER@$HOST" \
    "grep -c '${PUB_KEY}' ~/.ssh/authorized_keys" \
    2>/dev/null || echo "0")

  if [ "$INSTALLED" != "0" ]; then
    echo "already installed"
  else
    echo "$PUB_KEY" | ssh -o ConnectTimeout=15 \
      "$USER@$HOST" \
      'cat >> ~/.ssh/authorized_keys'
    echo "installed"
  fi
done <<< "$HOSTS"

# --- Step 3: Collect known_hosts ---

echo ""
echo "Collecting SSH host fingerprints..."

KNOWN_HOSTS=""
while IFS=' ' read -r NAME HOST; do
  echo -n "  $NAME ($HOST)... "
  FINGERPRINT=$(ssh-keyscan -T 10 "$HOST" 2>/dev/null)
  if [ -z "$FINGERPRINT" ]; then
    echo "FAILED (unreachable)"
    echo "Warning: could not reach $HOST"
    continue
  fi
  KNOWN_HOSTS="${KNOWN_HOSTS}${FINGERPRINT}
"
  echo "ok"
done <<< "$HOSTS"

# --- Step 4: Set GH secrets ---

echo ""
echo "Setting GH secrets..."

echo -n "  DEPLOY_SSH_KEY... "
gh secret set DEPLOY_SSH_KEY < "$KEY_FILE"
echo "set"

echo -n "  DEPLOY_KNOWN_HOSTS... "
echo "$KNOWN_HOSTS" | gh secret set DEPLOY_KNOWN_HOSTS
echo "set"

echo ""
echo "Done. Verify with:"
echo "  gh secret list"
echo ""
echo "Test with a dry run:"
echo "  gh workflow run deploy-relays.yml" \
  "-f dry_run=true"
