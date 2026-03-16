#!/usr/bin/env bash
set -euo pipefail

# Start or stop a fleet of ephemeral relay instances.
#
# Usage:
#   chaos-fleet.sh start <count> [--base-port N]
#     [--base-tcp-port N] [--pin-count N]
#     [--app-id ID]
#   chaos-fleet.sh stop
#   chaos-fleet.sh health
#   chaos-fleet.sh pids
#   chaos-fleet.sh bootstrap
#
# HTTP admin ports: BASE, BASE+10, BASE+20, ...
# TCP ports: BASE_TCP, BASE_TCP+10, BASE_TCP+20, ...
# WS ports: BASE_TCP+3, BASE_TCP+13, BASE_TCP+23, ...
# First --pin-count relays get --pin <app-id>.
# Storage: /tmp/chaos-relay-{0,1,...}/
# PID files: /tmp/chaos-relay-{0,1,...}.pid
# Logs: /tmp/chaos-relay-{0,1,...}.log

REPO="${CHAOS_REPO:-$(cd "$(dirname "$0")/../../.." \
  && pwd)}"
BASE_PORT=3000
BASE_TCP_PORT=4001
PIN_COUNT=2
APP_ID="pokapali-chaos-test"
ACTION=""
COUNT=0

parse_args() {
  ACTION="${1:-}"
  shift || true

  case "$ACTION" in
    start)
      COUNT="${1:-4}"
      shift || true
      ;;
    stop|health|pids|bootstrap) ;;
    *)
      echo "Usage: chaos-fleet.sh" \
        "start|stop|health|pids|bootstrap [opts]"
      exit 1
      ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --base-port) BASE_PORT="$2"; shift 2 ;;
      --base-tcp-port) BASE_TCP_PORT="$2"; shift 2 ;;
      --pin-count) PIN_COUNT="$2"; shift 2 ;;
      --app-id) APP_ID="$2"; shift 2 ;;
      *) echo "Unknown: $1"; exit 1 ;;
    esac
  done
}

relay_index() {
  local f="$1"
  # Extract index from /tmp/chaos-relay-N.pid
  f="${f##*relay-}"
  f="${f%.pid}"
  echo "$f"
}

start_fleet() {
  local i http_port tcp_port ws_port storage
  local pid_file log_file
  for ((i = 0; i < COUNT; i++)); do
    http_port=$((BASE_PORT + i * 10))
    tcp_port=$((BASE_TCP_PORT + i * 10))
    ws_port=$((tcp_port + 3))
    storage="/tmp/chaos-relay-$i"
    pid_file="/tmp/chaos-relay-$i.pid"
    log_file="/tmp/chaos-relay-$i.log"

    rm -rf "$storage"
    mkdir -p "$storage"

    local flags="--storage-path $storage"
    flags+=" --relay --no-tls"
    flags+=" --port $http_port"
    flags+=" --tcp-port $tcp_port"
    flags+=" --ws-port $ws_port"
    if [ "$i" -lt "$PIN_COUNT" ]; then
      flags+=" --pin $APP_ID"
    fi

    # shellcheck disable=SC2086
    node "$REPO/packages/node/dist/bin/node.js" \
      $flags \
      > "$log_file" 2>&1 &
    echo "$!" > "$pid_file"
    echo "relay-$i started" \
      "(PID $(cat "$pid_file")," \
      "http=$http_port, tcp=$tcp_port)"
  done

  # Wait for health endpoints
  echo "Waiting for fleet health..."
  for ((i = 0; i < COUNT; i++)); do
    http_port=$((BASE_PORT + i * 10))
    for attempt in $(seq 1 30); do
      if curl -sf -m 5 \
        "http://localhost:$http_port/health" \
        > /dev/null 2>&1; then
        echo "  relay-$i healthy"
        break
      fi
      if [ "$attempt" -eq 30 ]; then
        echo "  relay-$i FAILED to start"
        cat "/tmp/chaos-relay-$i.log"
        stop_fleet
        exit 1
      fi
      sleep 2
    done
  done

  echo "Fleet ready ($COUNT relays)"
}

stop_fleet() {
  for pid_file in /tmp/chaos-relay-*.pid; do
    [ -f "$pid_file" ] || continue
    local pid
    pid=$(cat "$pid_file")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  done
  rm -rf /tmp/chaos-relay-*/
  echo "Fleet stopped"
}

health_check() {
  for pid_file in /tmp/chaos-relay-*.pid; do
    [ -f "$pid_file" ] || continue
    local i http_port
    i=$(relay_index "$pid_file")
    http_port=$((BASE_PORT + i * 10))
    if curl -sf -m 5 \
      "http://localhost:$http_port/health" \
      > /dev/null 2>&1; then
      echo "relay-$i: healthy (port $http_port)"
    else
      echo "relay-$i: DOWN (port $http_port)"
    fi
  done
}

print_pids() {
  for pid_file in /tmp/chaos-relay-*.pid; do
    [ -f "$pid_file" ] || continue
    local i
    i=$(relay_index "$pid_file")
    echo "relay-$i: PID $(cat "$pid_file")"
  done
}

print_bootstraps() {
  for pid_file in /tmp/chaos-relay-*.pid; do
    [ -f "$pid_file" ] || continue
    local i http_port tcp_port peer_id
    i=$(relay_index "$pid_file")
    http_port=$((BASE_PORT + i * 10))
    tcp_port=$((BASE_TCP_PORT + i * 10))
    peer_id=$(curl -sf -m 5 \
      "http://localhost:$http_port/health" \
      | jq -r '.peerId')
    echo "/ip4/127.0.0.1/tcp/$tcp_port/p2p/$peer_id"
  done
}

parse_args "$@"

case "$ACTION" in
  start) start_fleet ;;
  stop) stop_fleet ;;
  health) health_check ;;
  pids) print_pids ;;
  bootstrap) print_bootstraps ;;
esac
