#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
command=${1:-status}
port_a=${CLAUDE_ZED_PORT_A:-8124}
provider_a=${CLAUDE_ZED_PROVIDER_A:-claude-code}
config_a=${CLAUDE_ZED_CONFIG_A:-}
port_b=${CLAUDE_ZED_PORT_B:-8125}
provider_b=${CLAUDE_ZED_PROVIDER_B:-claude-code-2}
config_b=${CLAUDE_ZED_CONFIG_B:-$HOME/.claude-account2}
domain="gui/$(id -u)"

label_for() {
  printf 'dev.claude-zed-shim-%s' "$1"
}

plist_for() {
  printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(label_for "$1")"
}

healthy() {
  curl -sf --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1
}

start_manual() {
  port=$1
  provider=$2
  config=$3
  if [ -n "$config" ]; then
    CLAUDE_CONFIG_DIR="$config" nohup node "$root/dist/cli.js" serve --port "$port" --provider-id "$provider" > "/tmp/claude-zed-$port.log" 2>&1 &
  else
    nohup node "$root/dist/cli.js" serve --port "$port" --provider-id "$provider" > "/tmp/claude-zed-$port.log" 2>&1 &
  fi
  echo $! > "/tmp/claude-zed-$port.pid"
}

start_one() {
  port=$1
  provider=$2
  config=$3
  label=$(label_for "$port")
  if healthy "$port"; then
    echo "$label already up"
    return
  fi
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "$domain/$label"
    echo "started $label"
    return
  fi
  plist=$(plist_for "$port")
  if [ -f "$plist" ]; then
    launchctl bootstrap "$domain" "$plist"
    launchctl kickstart -k "$domain/$label"
    echo "started $label"
    return
  fi
  start_manual "$port" "$provider" "$config"
  echo "started $label"
}

restart_one() {
  port=$1
  provider=$2
  config=$3
  label=$(label_for "$port")
  plist=$(plist_for "$port")
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "$domain/$label"
    echo "restarted $label"
    return
  fi
  if [ -f "$plist" ]; then
    launchctl bootstrap "$domain" "$plist"
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
  start_manual "$port" "$provider" "$config"
  echo "restarted $label"
}

stop_one() {
  port=$1
  label=$(label_for "$port")
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
    echo "stopped $label"
    return
  fi
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill $pid
    echo "stopped $label"
    return
  fi
  echo "$label already down"
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

logs_one() {
  port=$1
  label=$(label_for "$port")
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    tail -n 50 "$HOME/Library/Logs/claude-zed-shim/$port/out.log" "$HOME/Library/Logs/claude-zed-shim/$port/err.log" 2>/dev/null || true
  else
    tail -n 50 "/tmp/claude-zed-$port.log" 2>/dev/null || true
  fi
}

case "$command" in
  start)
    start_one "$port_a" "$provider_a" "$config_a"
    start_one "$port_b" "$provider_b" "$config_b"
    ;;
  restart)
    restart_one "$port_a" "$provider_a" "$config_a"
    restart_one "$port_b" "$provider_b" "$config_b"
    ;;
  stop)
    stop_one "$port_a"
    stop_one "$port_b"
    ;;
  status)
    status_one "$port_a"
    status_one "$port_b"
    ;;
  logs)
    logs_one "$port_a"
    logs_one "$port_b"
    ;;
  *)
    echo "Usage: shim.sh [start|stop|restart|status|logs]" >&2
    exit 2
    ;;
esac
