# Verification

Run after changes to the shim, installers, sessions, usage or tool bridge.

## Automated

```sh
npm ci
npm run verify
```

Expected: typecheck clean, all tests pass, `dist/cli.js` built.

## Two accounts

Account 2 login:

```sh
mkdir -p ~/.claude-account2
CLAUDE_CONFIG_DIR="$HOME/.claude-account2" claude auth login --claudeai
node dist/cli.js status --config-dir "$HOME/.claude-account2"
```

Account 1 and 2 servers:

```sh
node dist/cli.js serve --port 8124 --provider-id claude-code
CLAUDE_CONFIG_DIR="$HOME/.claude-account2" node dist/cli.js serve --port 8125 --provider-id claude-code-2
```

## Matrix

| Check | Command | Expected |
|---|---|---|
| Account A health | `curl -s 127.0.0.1:8124/health` | 200, models > 0 |
| Account B health | `curl -s 127.0.0.1:8125/health` | 200, models > 0 |
| Store separation | `ls ~/.local/share/claude-zed-shim` | two bucket dirs |
| Zed snippet | `node dist/cli.js models --port 8124 --provider-id claude-code` | valid JSON |
| OpenCode snippet | `node dist/cli.js models --port 8125 --provider-id claude-code-2 --format opencode` | `providers.claude-code-2` |
| Stream usage | `curl -N` chat request with `stream: true` | final chunk has `finish_reason` and `usage` |
| Tool call | Zed read/glob | response continues after tool result |
| CLAUDE.md | repo with marker text | model sees marker |
| Meta | Zed generate commit message | no new `sessions.json` binding |
| LaunchAgent A | `launchctl print gui/$(id -u)/dev.claude-zed-shim-8124` | exists |
| LaunchAgent B | `launchctl print gui/$(id -u)/dev.claude-zed-shim-8125` | exists |
| Windows 2 accounts | `start-windows.cmd` com `CLAUDE_CONFIG_DIR` e `CLAUDE_ZED_SHIM_PORT` | duas portas, dois config dirs |

## Debug

```sh
CLAUDE_ZED_DEBUG=1 node dist/cli.js serve --port 8124
```

Expected: JSON lines on stderr for request, resume, park, usage and error; no prompt or token content.

## Recovery

- Delete a transcript `.jsonl` while a binding exists, then send a follow-up: the shim must transfer history instead of starting context-free.
- Edit an earlier message: the shim must rewind or fork, not append to the old branch.
- Stop a parked turn: the next request must start cleanly.
