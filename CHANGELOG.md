# Changelog

## Unreleased

- Fast mode: `:fast` model ids (already exposed in the catalog/snippet) now actually turn fast mode on; `fast_mode` state is logged.
- Cancellation: a client that disconnects mid-turn stops the Claude turn (interrupt + drain) instead of letting it run to completion; parked turns are left for the follow-up request.
- Structured outputs: `response_format: { type: "json_schema" }` maps to the SDK `outputFormat`; the validated `structured_output` is returned as `content`. Unsupported `response_format` values return 400.
- Prompt fidelity: shim-composed prompts (tool-result relays, transferred history, meta turns) are sent `client_composed: true` so the CLI does not expand `@paths` or dispatch slash-commands inside them.
- Errors: error text is read from structured `result.errors` (with `result`/`error` fallbacks) and `system/api_retry` frames surface as SSE comments (`: retry 429 attempt 2/10 in 8s`).
- Parameters: `reasoning.effort` accepted in addition to `reasoning_effort`; `tool_choice: "none"` drops the tool bridge; `parallel_tool_calls: false` switches the turn instruction to one-call-at-a-time.
- Cleanup: removed the dead `temperature` field, the OpenCode `temperature` capability flag and the unused `structuredOutputReapMs`.

## 0.2.0

- Multi-account: per-port LaunchAgent labels, per-account logs, OpenCode v2 snippet.
- Sessions: turn boundaries, rewind, fork, missing-transcript history transfer.
- Protocol: usage in streaming and JSON, `finish_reason` mapping, narration signatures.
- Tools: `readOnlyHint`, string argument coercion, subagent list preservation.
- Instructions: project `CLAUDE.md`/`AGENTS.md` via `settingSources`.
- Meta requests: Zed title, summary and commit run as utility turns.
- Storage: atomic JSON writes with private permissions.
- Ops: opt-in debug log, Node 22.18+, CI and lockfile.
