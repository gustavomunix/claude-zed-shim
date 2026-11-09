# Claude Zed Shim v2 — Hardening and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar observabilidade, validação de CLI, regressão de turno interrompido, verificação real nas duas contas e checklist de release.

**Architecture:** Log opt-in em stderr, sem conteúdo sensível. Validação de porta no CLI. Teste de turno parkeado interrompido. Verificação manual documentada para Zed + OpenCode.

**Tech Stack:** TypeScript, `node:test`, HTTP local, launchd/Windows scripts.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-zed-shim-v2-design.md`

## Global Constraints

- Log nunca inclui token, prompt completo ou credencial.
- Porta válida: `1..65535`.
- Nenhuma mudança de comportamento sem teste de regressão.
- Verificação manual usa contas reais somente no fim.

## Review Focus

- Turno parkeado interrompido não pode deixar `tool_use` sem resposta na sessão.
- `--port 70000` não pode derrubar o processo com stack trace.
- Log de debug não pode vazar conteúdo do usuário.
- Duas contas não podem compartilhar sessões.
- Release não pode sair sem lockfile e CI verdes.

---

### Task 1: Logger de debug opt-in

**Files:**
- Create: `src/log.ts`
- Test: `test/log.test.ts`
- Modify: `src/server.ts` (request, resume, park, usage, error)
- Modify: `src/pool.ts` (stop/supersede)
- Modify: `README.md` (env var)

**Interfaces:**
- Produces:
  - `export function debugEnabled(): boolean`
  - `export function debugLog(event: string, data?: Record<string, unknown>): void`

- [ ] **Step 1: Write failing test**

```ts
it("does not write when disabled", () => {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    delete process.env.CLAUDE_ZED_DEBUG;
    debugLog("test", { a: 1 });
    assert.equal(writes.length, 0);
  } finally {
    process.stderr.write = original;
  }
});

it("writes one JSON line when enabled", () => {
  process.env.CLAUDE_ZED_DEBUG = "1";
  // capture stderr; parse line; assert event and fields
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/log.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

`debugLog` writes `JSON.stringify({ ts: Date.now(), event, ...data }) + "\n"` to stderr only when `process.env.CLAUDE_ZED_DEBUG === "1"`. Redact keys named `prompt`, `content`, `authorization`, `token`, `apiKey`.

- [ ] **Step 4: Add call sites**

Log only metadata:

- request: `{ model, provider: process.env.CLAUDE_ZED_PROVIDER_ID ?? null, stream, messages: messages.length, tools: tools.length }`;
- resume plan: `{ reason, resume: Boolean(resume), fork: Boolean(forkAt) }`;
- park: `{ pending: pendingTools.size }`;
- usage: `{ prompt_tokens, completion_tokens, total_tokens }`;
- classified error: `{ kind, status }`.

- [ ] **Step 5: Run tests**

Run: `node --test test/log.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/log.ts test/log.test.ts src/server.ts src/pool.ts README.md
git commit -m "feat: add opt-in debug logging"
```

---

### Task 2: Validar porta e melhorar `status`

**Files:**
- Modify: `src/cli.ts:18-33,69-79`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `parseCliOptions` rejeita porta `> 65535`; `status` aceita `--config-dir` e imprime config dir/bucket.

- [ ] **Step 1: Write failing tests**

```ts
assert.throws(() => parseCliOptions(["--port", "70000"]), /port/);
assert.throws(() => parseCliOptions(["--port", "65536"]), /port/);
assert.equal(parseCliOptions(["--port", "65535"]).port, 65535);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/cli.test.ts`
Expected: FAIL; only `> 0` is checked.

- [ ] **Step 3: Implement**

Reject non-integer or `> 65535`. In the `status` command, parse `--config-dir`, call `applyConfigDir`, then `printStatus`. In `printStatus`, print:

```text
Config dir: <path or (default)>
Store bucket: <12-char hash or (legacy)>
```

Import `configBucket` from `store.ts`.

- [ ] **Step 4: Run tests**

Run: `node --test test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "fix: validate port range and show account bucket"
```

---

### Task 3: Regressão de turno parkeado interrompido

**Files:**
- Modify: `src/pool.ts:61-66` (only if the test proves necessary)
- Test: `test/server-session.test.ts`

**Interfaces:**
- Consumes: fake query starter, `stopBridge`, `findBridgeByConversation`.
- Produces: garantia de que um turno interrompido não impede o próximo.

- [ ] **Step 1: Write failing test**

Simulate:

1. Fake handle emits a tool call and parks.
2. Call `stopConversationBridges(key, "test")`.
3. Post a new request for the same conversation.
4. Assert the fake starter was called with a `resume` that is either absent or the same session, never a broken pending state; the response is 200.

The test must also assert no unhandled rejection escapes: attach `process.once("unhandledRejection")` and fail if fired.

- [ ] **Step 2: Run to verify it fails or exposes the bug**

Run: `node --test test/server-session.test.ts`
Expected: if the current reject path leaves a hanging promise, FAIL; otherwise PASS and the test becomes a regression guard.

- [ ] **Step 3: Implement only if needed**

If the test fails, change `rejectPending` to resolve each pending tool with:

```ts
[{ type: "text", text: "[turn cancelled before the tool returned]" }]
```

instead of rejecting. Keep `stopBridge` semantics: the bridge leaves the pool first, then settles pending calls. Update the `ParkedToolCall` type so `reject` can be removed if unused.

- [ ] **Step 4: Run tests**

Run: `node --test test/server-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pool.ts test/server-session.test.ts
git commit -m "test: cover interrupted parked turns"
```

---

### Task 4: Verificação real Zed + OpenCode

**Files:**
- Create: `docs/verification.md`
- Modify: `README.md`

**Interfaces:**
- Produces: checklist reproduzível para duas contas.

- [ ] **Step 1: Document account setup**

Commands:

```sh
mkdir -p ~/.claude-account2
CLAUDE_CONFIG_DIR="$HOME/.claude-account2" claude auth login --claudeai
node dist/cli.js status --config-dir "$HOME/.claude-account2"
```

- [ ] **Step 2: Document Zed providers**

Two providers with ports 8124/8125. Run `npm run models -- --format zed` once per provider. Add `api_key: "dummy"`.

- [ ] **Step 3: Document OpenCode providers**

Native Claude provider remains. Add `providers.claude-code-2` via `npm run models -- --format opencode`. Use `apiKey: "dummy"`.

- [ ] **Step 4: Add the verification matrix**

| Check | Command | Expected |
|---|---|---|
| Build | `npm run verify` | clean |
| Account A health | `curl 127.0.0.1:8124/health` | 200, models > 0 |
| Account B health | `curl 127.0.0.1:8125/health` | 200, models > 0 |
| Store separation | `ls ~/.local/share/claude-zed-shim` | two bucket dirs |
| Stream usage | `curl -N ...` | final chunk has usage |
| Tool call | Zed read/glob | response continues after tool |
| CLAUDE.md | repo with marker | model sees marker |
| Meta | generate commit message | no new sessions.json entry |
| LaunchAgent | `launchctl print gui/$(id -u)/dev.claude-zed-shim-8124` | exists |
| LaunchAgent 2 | `.../dev.claude-zed-shim-8125` | exists |
| Windows 2 contas | `start-windows.cmd` com `CLAUDE_CONFIG_DIR` e `CLAUDE_ZED_SHIM_PORT` | duas portas, dois config dirs |

- [ ] **Step 5: Commit**

```bash
git add docs/verification.md README.md
git commit -m "docs: add two-account verification matrix"
```

---

### Task 5: Release checklist

**Files:**
- Modify: `CHANGELOG.md` (create if absent)
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: versão `0.2.0` e checklist de release.

- [ ] **Step 1: Bump version**

`package.json` → `"version": "0.2.0"`.

- [ ] **Step 2: Write CHANGELOG**

Seções: multi-conta, sessão, usage, tools, instruções, meta, storage, Node/CI.

- [ ] **Step 3: Final verification**

Run:

```sh
npm ci
npm run verify
git status --short
```

Expected: clean, CI-equivalent commands pass, lockfile tracked.

- [ ] **Step 4: Manual smoke**

Run the matrix from `docs/verification.md` with two real accounts. Record date and results in the PR/commit message.

- [ ] **Step 5: Commit and tag**

```bash
git add package.json CHANGELOG.md README.md
git commit -m "chore: release v0.2.0"
git tag v0.2.0
```
