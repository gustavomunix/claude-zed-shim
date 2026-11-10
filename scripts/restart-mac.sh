#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
command=${1:-restart}
port_a=${CLAUDE_ZED_PORT_A:-8124}
provider_a=${CLAUDE_ZED_PROVIDER_A:-claude-mletras}
config_a=${CLAUDE_ZED_CONFIG_A:-}
port_b=${CLAUDE_ZED_PORT_B:-8125}
provider_b=${CLAUDE_ZED_PROVIDER_B:-claude-luciana}
config_b=${CLAUDE_ZED_CONFIG_B:-$HOME/.claude-account2}
domain="gui/$(id -u)"

label_for() {
  printf 'dev.claude-zed-shim-%s' "$1"
}

restart_one() {
  port=$1
  provider=$2
  config=$3
  label=$(label_for "$port")
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "$domain/$label"
    echo "restarted $label"
    return
  fi
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill $pid
    for _ in 1 2 3 4 5; do
      lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  if [ -n "$config" ]; then
    CLAUDE_CONFIG_DIR="$config" nohup node "$root/dist/cli.js" serve --port "$port" --provider-id "$provider" > "/tmp/claude-zed-$port.log" 2>&1 &
  else
    nohup node "$root/dist/cli.js" serve --port "$port" --provider-id "$provider" > "/tmp/claude-zed-$port.log" 2>&1 &
  fi
  echo $! > "/tmp/claude-zed-$port.pid"
  echo "started $label"
}

status_one() {
  port=$1
  label=$(label_for "$port")
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    echo "$label launchd"
  else
    echo "$label manual"
  fi
  curl -s --max-time 2 "http://127.0.0.1:$port/health" || echo "$label down"
  echo
}

case "$command" in
  restart|start)
    restart_one "$port_a" "$provider_a" "$config_a"
    restart_one "$port_b" "$provider_b" "$config_b"
    ;;
  status)
    status_one "$port_a"
    status_one "$port_b"
    ;;
  *)
    echo "Usage: restart-mac.sh [restart|start|status]" >&2
    exit 2
    ;;
esac
