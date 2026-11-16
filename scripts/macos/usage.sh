#!/bin/sh
set -eu

config_a=${CLAUDE_ZED_CONFIG_A:-}
config_b=${CLAUDE_ZED_CONFIG_B:-$HOME/.claude-account2}

usage_one() {
  echo "== $1"
  if [ -n "$2" ]; then
    CLAUDE_CONFIG_DIR="$2" claude -p "/usage" | sed -n '3,5p'
  else
    env -u CLAUDE_CONFIG_DIR claude -p "/usage" | sed -n '3,5p'
  fi
}

usage_one "conta 1" "$config_a"
usage_one "conta 2" "$config_b"
