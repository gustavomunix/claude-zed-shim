#!/bin/sh
set -eu

port=${PORT:-8124}
case "$port" in
  ''|*[!0-9]*)
    echo "PORT must be numeric" >&2
    exit 1
    ;;
esac
port=$(printf '%s' "$port" | sed 's/^0*//')
[ -n "$port" ] || port=0
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo "PORT must be between 1 and 65535" >&2
  exit 1
fi
config_dir=${CONFIG_DIR:-}
provider_id=${PROVIDER_ID:-claude-code}
label="dev.claude-zed-shim-$port"
old_label="dev.claude-zed-shim"
root=$(cd "$(dirname "$0")/.." && pwd)
plist="$HOME/Library/LaunchAgents/$label.plist"
old_plist="$HOME/Library/LaunchAgents/$old_label.plist"
log_dir="$HOME/Library/Logs/claude-zed-shim/$port"
domain="gui/$(id -u)"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

remove_legacy() {
  if [ "$port" = "8124" ]; then
    launchctl bootout "$domain/$old_label" 2>/dev/null || true
    rm -f "$old_plist"
  fi
}

build_plist() {
  escaped_node=$(xml_escape "$node_bin")
  escaped_root=$(xml_escape "$root")
  escaped_log_dir=$(xml_escape "$log_dir")
  escaped_provider=$(xml_escape "$provider_id")

  config_args=""
  if [ -n "$config_dir" ]; then
    config_args="    <string>--config-dir</string>
    <string>$(xml_escape "$config_dir")</string>"
  fi

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_node</string>
    <string>$escaped_root/dist/cli.js</string>
    <string>serve</string>
    <string>--port</string>
    <string>$port</string>
$config_args
    <string>--provider-id</string>
    <string>$escaped_provider</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$escaped_root</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$escaped_log_dir/out.log</string>
  <key>StandardErrorPath</key>
  <string>$escaped_log_dir/err.log</string>
</dict>
</plist>
EOF
}

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  remove_legacy
  echo "Removed $label"
  exit 0
fi

node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  build_plist
  exit 0
fi

cd "$root"
npm install
npm run build

mkdir -p "$log_dir" "$(dirname "$plist")"
build_plist > "$plist"
remove_legacy

launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl kickstart -k "$domain/$label"

echo "Installed $label on http://127.0.0.1:$port"
echo "Logs: $log_dir"
