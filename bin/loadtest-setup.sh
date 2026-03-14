#!/usr/bin/env bash
set -euo pipefail

# Set up GH secrets for the nightly load test VPS.
#
# Usage:
#   bin/loadtest-setup.sh
#
# Prerequisites:
#   - gh CLI authenticated
#   - SSH access to pokapali-test (via ~/.ssh/config)
#   - SSH access to all relay nodes (for peer IDs)
#   - deploy/nodes.json with relay + test_runners config
#
# This script:
#   1. Generates an ed25519 deploy key (if needed)
#   2. Installs the public key on pokapali-test
#   3. Collects SSH host fingerprint
#   4. Builds bootstrap peer multiaddrs from relay nodes
#   5. Sets GH secrets: LOADTEST_SSH_KEY,
#      LOADTEST_SSH_KNOWN_HOSTS, LOADTEST_SSH_HOST,
#      LOADTEST_BOOTSTRAP_PEERS

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$ROOT_DIR/deploy/nodes.json"
KEY_FILE="$ROOT_DIR/deploy/.loadtest-key"

if [ ! -f "$CONFIG" ]; then
  echo "Error: $CONFIG not found"
  exit 1
fi

# Read test runner host from config
TEST_HOST=$(jq -r \
  '.test_runners[0].host // empty' "$CONFIG")
if [ -z "$TEST_HOST" ]; then
  echo "Error: no test_runners in $CONFIG"
  exit 1
fi

USER=$(jq -r '.defaults.user' "$CONFIG")

echo "Test VPS: $TEST_HOST"
echo ""

# --- Step 1: Generate deploy key ---

if [ -f "$KEY_FILE" ]; then
  echo "Deploy key already exists at $KEY_FILE"
  echo "Delete it to regenerate."
else
  echo "Generating ed25519 deploy key..."
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" \
    -C "gha-loadtest-deploy"
  echo "Key generated: $KEY_FILE"
fi

PUB_KEY=$(cat "${KEY_FILE}.pub")

# --- Step 2: Install public key on test VPS ---

echo ""
echo "Installing public key on test VPS..."
echo -n "  $TEST_HOST... "

if ssh -n -o ConnectTimeout=15 \
  "$USER@$TEST_HOST" \
  "grep -qF gha-loadtest-deploy \
    ~/.ssh/authorized_keys" \
  2>/dev/null; then
  echo "already installed"
else
  echo "$PUB_KEY" | ssh -o ConnectTimeout=15 \
    "$USER@$TEST_HOST" \
    'cat >> ~/.ssh/authorized_keys'
  echo "installed"
fi

# --- Step 3: Collect known_hosts ---

echo ""
echo "Collecting SSH host fingerprint..."
echo -n "  $TEST_HOST... "

KNOWN_HOSTS=$(ssh-keyscan -T 10 "$TEST_HOST" \
  2>/dev/null)
if [ -z "$KNOWN_HOSTS" ]; then
  echo "FAILED (unreachable)"
  exit 1
fi
echo "ok"

# --- Step 4: Build bootstrap peer multiaddrs ---

echo ""
echo "Collecting relay peer IDs..."

BOOTSTRAP_PEERS=""
RELAYS=$(jq -r \
  '.batches[].nodes[] |
   "\(.name) \(.host)"' "$CONFIG")

while IFS=' ' read -r NAME HOST; do
  echo -n "  $NAME ($HOST)... "

  # Get peer ID from health endpoint
  PEER_ID=$(curl -s -m 10 \
    "http://$HOST:3000/health" \
    | jq -r '.peerId // empty' \
    2>/dev/null || true)

  if [ -z "$PEER_ID" ]; then
    echo "FAILED (health endpoint unreachable)"
    echo "Warning: skipping $NAME"
    continue
  fi

  ADDR="/ip4/$HOST/tcp/4001/ws/p2p/$PEER_ID"
  if [ -n "$BOOTSTRAP_PEERS" ]; then
    BOOTSTRAP_PEERS="${BOOTSTRAP_PEERS}
${ADDR}"
  else
    BOOTSTRAP_PEERS="$ADDR"
  fi
  echo "$PEER_ID"
done <<< "$RELAYS"

if [ -z "$BOOTSTRAP_PEERS" ]; then
  echo "Error: no bootstrap peers collected"
  exit 1
fi

echo ""
echo "Bootstrap peers:"
echo "$BOOTSTRAP_PEERS" | while read -r ADDR; do
  echo "  $ADDR"
done

# --- Step 5: Set GH secrets ---

echo ""
echo "Setting GH secrets..."

echo -n "  LOADTEST_SSH_KEY... "
gh secret set LOADTEST_SSH_KEY < "$KEY_FILE"
echo "set"

echo -n "  LOADTEST_SSH_HOST... "
echo "$TEST_HOST" | gh secret set LOADTEST_SSH_HOST
echo "set"

echo -n "  LOADTEST_SSH_KNOWN_HOSTS... "
echo "$KNOWN_HOSTS" \
  | gh secret set LOADTEST_SSH_KNOWN_HOSTS
echo "set"

echo -n "  LOADTEST_BOOTSTRAP_PEERS... "
echo "$BOOTSTRAP_PEERS" \
  | gh secret set LOADTEST_BOOTSTRAP_PEERS
echo "set"

echo ""
echo "Done. Verify with:"
echo "  gh secret list"
echo ""
echo "Bootstrap peers format (newline-separated):"
echo "  Each line is a multiaddr:"
echo "  /ip4/<ip>/tcp/4001/ws/p2p/<peerID>"
echo ""
echo "Usage in workflow:"
echo "  while IFS= read -r ADDR; do"
echo "    ARGS+=(--bootstrap \"\$ADDR\")"
echo "  done <<< \"\$BOOTSTRAP_PEERS\""
