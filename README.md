# claude-zed-shim

Local OpenAI-compatible proxy that exposes your **Claude Code subscription** (plan, via `claude` CLI + Agent SDK) as a regular provider in **Zed Agent** — model dropdown, same list style as `antigravity-zed-shim`. No API key; auth stays with the CLI.

How it works:

- Auth: probes `claude auth status --json`. Refuses API-key/Bedrock logins with 401 + guidance. Never reads/copies tokens.
- Server: `node:http` on `127.0.0.1:8124` — `POST /v1/chat/completions` (stream SSE + JSON), `GET /v1/models`, `GET /health`.
- Tools: Zed `tools` bridged as in-process MCP (`mcp__zed__*`), Claude built-ins disabled (`tools: []`, `permissionMode: dontAsk`, `isolateMcp: true`). Parked turns resume on next request with tool results.
- Sessions: keyed by hash of model+system+user history (Zed sends no session header). Resume, rewind/diverge handling, 1h parked TTL.

## Prerequisites

- Node.js >= 20, Windows/macOS/Linux.
- Claude Code CLI installed and logged in: `claude auth login --claudeai`. Check with `node dist/cli.js status`.

## Setup

```sh
cd claude-zed-shim
npm install
npm run build

# 1. Check CLI + subscription
node dist/cli.js status

# 2. Start the proxy (default port 8124, runs beside antigravity :8123)
npm run serve

# 3. Print settings.json snippet with live models
npm run models
```

Paste the snippet into Zed `settings.json` (`zed: open settings`), merging the `language_models.openai_compatible.claude-code` block.

Zed requires a non-empty API key for `openai_compatible`: use any dummy value (agent Settings or `CLAUDE_CODE_API_KEY=dummy`). The shim ignores it.

## Commands

| Command           | What it does                              |
| ----------------- | ----------------------------------------- |
| `npm run serve`   | Build + start proxy on `127.0.0.1:8124`   |
| `npm run models`  | Print `settings.json` snippet, live ids   |
| `npm run status`  | CLI present? logged in? model count       |
| `npm run self-test` | Offline checks (no network)             |
| `npm test`        | Full suite (`node --test test/`)          |
| `npm run typecheck` | `tsc --noEmit`                          |

### Windows background

- `start-windows.cmd`: minimized console on port 8124 (builds first run).
- `start-silent.vbs`: fully hidden; shortcut to `shell:startup` for boot.
- `stop-windows.cmd`: kills process on port 8124.

## Env knobs

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `CLAUDE_ZED_CWD` | `process.cwd()` | Working dir for Claude Code turns |
| `CLAUDE_CONFIG_DIR` | unset | Alternate Claude account per project |
| `CLAUDE_ZED_PARKED_TURN_TTL_MS` | 3600000 | Parked-turn reap; `0` disables |
| `CLAUDE_ZED_TURN_STALL_MS` | 600000 | Silent-turn kill watchdog |
| `OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS` | 60000 | Structured-output park reap |

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| 401 auth | `claude auth login --claudeai`; API keys unsupported here — use native Anthropic provider |
| `tools: []` but Zed sent tools + 503 | SDK MCP bridge failed; retry; check debug log |
| Parked turn never resumes | TTL reaps after 1h; Zed history replaced triggers supersede |
| No models | `node dist/cli.js status`; CLI missing or signed out |
