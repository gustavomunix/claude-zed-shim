# claude-zed-shim

Local OpenAI-compatible proxy that exposes your **Claude Code subscription** (plan, via `claude` CLI + Agent SDK) as a regular provider in **Zed Agent** — model dropdown, same list style as `antigravity-zed-shim`. No API key; auth stays with the CLI.

How it works:

- Auth: probes `claude auth status --json`. Refuses API-key/Bedrock logins with 401 + guidance. Never reads/copies tokens.
- Server: `node:http` on `127.0.0.1:8124` — `POST /v1/chat/completions` (stream SSE + JSON), `GET /v1/models`, `GET /health`.
- Tools: Zed `tools` bridged as in-process MCP (`mcp__zed__*`), Claude built-ins disabled (`tools: []`, `permissionMode: dontAsk`, `isolateMcp: true`). Parked turns resume on next request with tool results.
- Sessions: keyed by hash of model+system+user history (Zed sends no session header). Resume, rewind/diverge handling, 1h parked TTL.

## Prerequisites

- Node.js >= 22.18, Windows/macOS/Linux.
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

## Reasoning effort

Each model's levels come from the Agent SDK catalog (`supportedModels()` → `supportedEffortLevels`). The `models` snippet writes them as `reasoning_effort_levels` with `reasoning_effort: "high"` as the default, so Zed shows an effort selector. Models without effort support (e.g. `claude-haiku-4-5-20251001`) get neither field.

On each request the shim reads `reasoning_effort`:

| Value from Zed | What Claude Code gets |
| --- | --- |
| `low`, `medium`, `high`, `xhigh`, `max` | Passed as the SDK `effort` option, unchanged |
| `minimal`, any other value, or none | No `effort` option: Claude Code uses its own default (`effortLevel` in that account's Claude settings, else the model default) |

The shim does not clamp a level against the model's list: a level the model lacks (e.g. `xhigh` on `claude-sonnet-4-6`) is still sent, and Claude Code decides how to run it. Title and summary requests from Zed never carry an effort.

## Images and files

User messages accept OpenAI and Anthropic-style parts: `image_url` (data URL or `http(s)` URL), `image` (base64, `source`, or URL), `input_image`, `file` / `input_file` (`file_data`, `data`, `url`), and `document`. Images become Anthropic `image` blocks, PDFs become `document` blocks. Remote `http(s)` URLs are passed as URL sources; Claude fetches them.

Tool results can carry media too, in any of the shapes clients use:

- parts array in the `tool` message content;
- the same array JSON-encoded as a string (`"[{\"type\":\"image_url\",...}]"`);
- media promoted to a `user` message right after the tool messages (plain `Attached media from tool result:` text or no text). The shim attaches it to the step's last tool result instead of treating it as a new user turn.

If the parked turn that made the tool calls is gone (shim restart, TTL), the next request relays the tool results and their media to Claude in a new prompt, and Claude continues from there.

## Fast mode

Models whose `supportsFastMode` comes back from the agent SDK catalog appear twice in the snippet, e.g. `claude-opus-5-5` and `claude-opus-5-5:fast`. The `:fast` id resolves to the base model with Claude Code's `fastMode` settings flag turned on for that turn (see [fast mode](https://code.claude.com/docs/en/fast-mode)): supported on Opus 5.5, Opus 5 and Opus 4.8, billed to usage credits. When fast mode can't run, the request silently falls back to standard speed — the shim logs `fast_mode` state in the debug log.

## Parameters

What each request field does:

| Field | Behavior |
| --- | --- |
| `reasoning_effort` / `reasoning.effort` | Passed as the SDK `effort` option (`low`–`max`); any other value falls back to Claude Code's default (see the table above) |
| `response_format: { type: "json_schema" }` | Passed as the SDK `outputFormat`; Claude validates and retries, the parsed object is returned as the response `content`. Other values return 400 |
| `tool_choice: "none"` | No Zed tools are registered for the turn |
| `parallel_tool_calls: false` | The turn-level instruction becomes "at most one tool call at a time" |
| `stream_options`, `n`, `seed`, `logit_bias`, … | Ignored |
| `temperature`, `top_p`, `stop`, `max_tokens` | Not forwarded: the Claude Code harness does not expose sampling controls (the temperature slider does nothing here) |

Shim-composed prompts (`<tool_results>` relays, transferred history, title/summary/commit utility turns) are marked `client_composed: true`, so Claude Code delivers them as written — no `@path` expansion, no slash-command dispatch. Your own messages go through Claude Code's normal handling.

## Commands

| Command           | What it does                              |
| ----------------- | ----------------------------------------- |
| `npm run serve`   | Build + start proxy on `127.0.0.1:8124`   |
| `npm run models`  | Print Zed snippet, live ids                |
| `npm run models -- --format opencode` | Print OpenCode v2 provider snippet |
| `npm run status`  | CLI present? logged in? model count       |
| `npm run self-test` | Offline checks (no network)             |
| `npm test`        | Full suite (`node --test "test/*.test.ts"`) |
| `npm run typecheck` | `tsc --noEmit`                          |
| `npm run verify`  | Typecheck + tests + build                 |

### Restart

```sh
sh scripts/macos/shim.sh start
sh scripts/macos/shim.sh stop
sh scripts/macos/shim.sh restart
sh scripts/macos/shim.sh status
sh scripts/macos/shim.sh logs
```

With the dotfile helper, from any directory:

```sh
claude-shim restart
claude-shim status
```

The script uses `launchctl` when the per-port LaunchAgent exists; otherwise it starts a background process with logs in `/tmp/claude-zed-<port>.log`.

### Windows background

- `start-windows.cmd`: minimized console on port 8124 (builds first run). Reads `CLAUDE_ZED_SHIM_PORT` to override.
- `start-silent.vbs`: fully hidden; shortcut to `shell:startup` for boot. Same port env.
- `stop-windows.cmd`: kills process on port 8124. Reads `CLAUDE_ZED_SHIM_PORT` to match.

## Two accounts (optional)

Run two Claude accounts side by side. Second instance is entirely optional — a single-account setup needs nothing below. Note: with `CLAUDE_CONFIG_DIR` set, the shim keeps a separate `sessions.json`/`models.json` under that bucket — conversation bindings from a `CLAUDE_CONFIG_DIR`-less setup won't carry over.

1. Login once with a separate config dir (PowerShell):

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account2"
claude auth login --claudeai
Remove-Item Env:\CLAUDE_CONFIG_DIR
```

2. Start a second shim instance on another port (same repo):

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account2"
node dist\cli.js serve --port 8125 --provider-id claude-code-2
```

Or via the runners (each runner picks up the env you set at launch, CMD or PowerShell):

```powershell
$env:CLAUDE_ZED_SHIM_PORT = "8125"
.\start-windows.cmd
```

3. Print the Zed snippet for the second provider:

```powershell
node dist\cli.js models --port 8125 --provider-id claude-code-2
```

4. Merge into Zed `settings.json` under `language_models.openai_compatible` next to `claude-code`. For the Zed ACP path, duplicate `agent_servers.Claude` as e.g. `Claude (work)` and set `"env": { "CLAUDE_CONFIG_DIR": "%USERPROFILE%\\.claude-account2" }`.

Model list and auth always follow the `CLAUDE_CONFIG_DIR` of the server process; each instance owns its account. The provider id is free — name each instance whatever makes sense for you (`--provider-id claude-code-work`, `claude-code-personal`, …); it is only the key in Zed's `settings.json` / OpenCode's `opencode.jsonc`.

### OpenCode (v2)

OpenCode's native Claude provider can keep account 1. Point the shim at account 2 and add its provider block:

```sh
node dist/cli.js models --port 8125 --provider-id claude-code-2 --format opencode
```

Merge the printed `providers.claude-code-2` object into `~/.config/opencode/opencode.jsonc`. The shape is:

```json
{
  "providers": {
    "claude-code-2": {
      "name": "Claude (claude-code-2)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8125/v1",
        "apiKey": "dummy"
      },
      "models": {}
    }
  }
}
```

`models` is filled by the command with the live catalog. The shim ignores the API key. Two shim instances also work: run a second process with another port/config dir and add a second `providers` entry.

### Usage (macOS)

Subscription limits (5h session and weekly) for both accounts, same data as `/usage` inside Claude Code:

```sh
sh scripts/macos/usage.sh
```

It runs `claude -p "/usage"` once per account and prints the three limit lines. Account 1 uses Claude's default config (no `CLAUDE_CONFIG_DIR`), account 2 to `~/.claude-account2`; override with `CLAUDE_ZED_CONFIG_A` / `CLAUDE_ZED_CONFIG_B`. For the full report, run `CLAUDE_CONFIG_DIR="$HOME/.claude-account2" claude -p "/usage"`.

Per-turn token counts are separate: start the shim with `CLAUDE_ZED_DEBUG=1` and read the `usage` lines in its log.

## Installers

Both installers install dependencies, build, and can self-register the shim:
- **Windows** — `scripts/install.ps1` (`-Port`, `-ConfigDir`, `-ProviderId`, `-Startup`, `-Uninstall`). `-Startup` registers a hidden launcher (`wscript` `.generated.vbs`, no console window, same approach as `start-silent.vbs`): stopping means `stop-windows.cmd` or Task Manager, not a window close.

```powershell
.\scripts\install.ps1 -Startup -Port 8124 -ProviderId claude-code-personal
.\scripts\install.ps1 -Startup -Port 8125 -ConfigDir "$HOME\.claude-account2" -ProviderId claude-code-work
```

- **macOS** — `scripts/macos/install.sh` (`PORT`, `CONFIG_DIR`, `PROVIDER_ID` env vars; launchd `LaunchAgent` with `KeepAlive`). The label is `dev.claude-zed-shim-<port>`, so each account has its own job. Logs go to `~/Library/Logs/claude-zed-shim/<port>/`. `PORT=8125 sh scripts/macos/install.sh uninstall` removes only that instance; port 8124 also migrates the old label. `DRY_RUN=1` prints the plist without installing.

```sh
PORT=8124 PROVIDER_ID=claude-code-personal sh scripts/macos/install.sh
CONFIG_DIR="$HOME/.claude-account2" PORT=8125 PROVIDER_ID=claude-code-work sh scripts/macos/install.sh
```

For a second account, log it in first (see "Two accounts"), then install its instance with the matching `CONFIG_DIR`.

## Env knobs

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `CLAUDE_ZED_CWD` | `process.cwd()` | Working dir for Claude Code turns |
| `CLAUDE_CONFIG_DIR` | unset | Alternate Claude account for this shim instance (CLI/login equivalent: `claude2`) |
| `CLAUDE_ZED_SHIM_PORT` | 8124 | Port for the Windows runners (`start`/`stop`/`vbs`) |
| `CLAUDE_ZED_PARKED_TURN_TTL_MS` | 3600000 | Parked-turn reap; `0` disables |
| `CLAUDE_ZED_TURN_STALL_MS` | 600000 | Silent-turn kill watchdog |
| `CLAUDE_ZED_DEBUG` | unset | `1` writes JSON debug lines to stderr |
| `OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS` | 60000 | Structured-output park reap |

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| 401 auth | `claude auth login --claudeai`; API keys unsupported here — use native Anthropic provider |
| `tools: []` but Zed sent tools + 503 | SDK MCP bridge failed; retry; check debug log |
| Parked turn never resumes | TTL reaps after 1h; Zed history replaced triggers supersede |
| No models | `node dist/cli.js status`; CLI missing or signed out |

Reference map and ported ranges: `docs/provenance.md`. Two-account checks: `docs/verification.md`.
