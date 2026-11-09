# Claude Zed Shim v2 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar a base do shim segura para duas contas e dois clientes: persistência atômica, snippets Zed/OpenCode, instalador macOS por instância, Node/CI e documentação de operação.

**Architecture:** Mantém uma instância por conta. `CLAUDE_CONFIG_DIR` particiona store e cache de modelos. O CLI ganha um formato de snippet para OpenCode além do Zed. A escrita de JSON passa a ser atômica. O LaunchAgent macOS passa a ter label por porta, com migração do label antigo.

**Tech Stack:** TypeScript, Node 22.18+, esbuild, `node:test`, `node:fs`, shell/launchd.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-zed-shim-v2-design.md`

## Global Constraints

- Node mínimo: `22.18.0`.
- Nenhuma credencial lida, copiada ou logada.
- Servidor escuta apenas `127.0.0.1`.
- `sessions.json` existente continua legível.
- Uma instância por `CLAUDE_CONFIG_DIR`; sem lock entre processos.
- `package-lock.json` versionado.
- Testes existentes continuam passando.

## Review Focus

- Crash durante escrita de `sessions.json` não pode corromper o arquivo.
- Dois config dirs distintos não podem compartilhar `sessions.json`/`models.json`.
- Segundo `install-mac.sh` em outra porta não pode remover o primeiro LaunchAgent.
- `models --format opencode` precisa gerar schema aceito pelo OpenCode v2.2.5.
- Modelos com `:fast` não podem gerar chave inválida no OpenCode.

---

### Task 1: Escrita atômica de JSON

**Files:**
- Create: `src/json-file.ts`
- Test: `test/json-file.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:path`, `node:os`.
- Produces:
  - `readJsonFile<T>(path: string): T | null`
  - `writeJsonFileAtomic(path: string, value: unknown): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFile, writeJsonFileAtomic } from "../src/json-file.ts";

describe("json-file", () => {
  it("writes and reads an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      const path = join(dir, "nested", "value.json");
      writeJsonFileAtomic(path, { hello: "world" });
      assert.deepEqual(readJsonFile(path), { hello: "world" });
      assert.match(readFileSync(path, "utf8"), /"hello": "world"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for missing or invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      assert.equal(readJsonFile(join(dir, "missing.json")), null);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ nope");
      assert.equal(readJsonFile(bad), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the old value", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      const path = join(dir, "value.json");
      writeJsonFileAtomic(path, { version: 1 });
      writeJsonFileAtomic(path, { version: 2 });
      assert.deepEqual(readJsonFile(path), { version: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/json-file.test.ts`
Expected: FAIL with `Cannot find module '../src/json-file.ts'`.

- [ ] **Step 3: Implement `src/json-file.ts`**

Use `readFileSync`/`JSON.parse` for read. For write: `mkdirSync(dirname(path), { recursive: true })`, create `${path}.${process.pid}.${Date.now()}.tmp`, `writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })`, `renameSync(temp, path)`, and unlink the temp file on failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/json-file.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/json-file.ts test/json-file.test.ts
git commit -m "feat: add atomic JSON persistence helper"
```

---

### Task 2: Usar escrita atômica em store e models

**Files:**
- Modify: `src/store.ts:44-69`
- Modify: `src/models.ts:135-160`
- Test: `test/store.test.ts`, `test/models.test.ts`

**Interfaces:**
- Consumes: `writeJsonFileAtomic`, `readJsonFile` da Task 1.
- Produces: mesmas funções públicas de `store.ts`/`models.ts`.

- [ ] **Step 1: Add failing permission/atomicity tests**

In `test/store.test.ts`, add:

```ts
it("writes the sessions file with private permissions", () => {
  const previous = process.env.XDG_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "claude-zed-store-"));
  try {
    process.env.XDG_DATA_HOME = dir;
    setForeignSessionId("k", "session-1");
    assert.equal(getForeignSessionId("k"), "session-1");
    assert.equal(statSync(storePath()).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

it("survives a corrupt sessions.json without throwing", () => {
  const previous = process.env.XDG_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "claude-zed-store-"));
  try {
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "claude-zed-shim"), { recursive: true });
    writeFileSync(storePath(), "{ broken");
    assert.equal(getForeignSessionId("missing"), undefined);
    assert.deepEqual(getSessionTurns("missing"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});
```

In `test/models.test.ts`, add the equivalent permission assertion for `modelCachePath()` after `setDiscoveredModels(...)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.ts test/models.test.ts`
Expected: FAIL; current direct `writeFileSync` creates `0644` files under the default umask.

- [ ] **Step 3: Implement**

Replace `writeFileSync(storePath(), ...)` with `writeJsonFileAtomic(storePath(), store)`. Replace `readStore` body with `readJsonFile<Record<string, ClaudeSessionBinding>>(storePath()) ?? {}`. Do the same in `readCachedModels`/`writeCachedModels`.

- [ ] **Step 4: Run tests**

Run: `node --test test/store.test.ts test/models.test.ts test/json-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/models.ts test/store.test.ts test/models.test.ts
git commit -m "fix: persist sessions and models atomically"
```

---

### Task 3: Node mínimo, lockfile e CI

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md:12-15`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run verify` = `npm run typecheck && npm test && npm run build`.

- [ ] **Step 1: Update `package.json`**

```json
"engines": { "node": ">=22.18.0" },
"scripts": {
  "verify": "npm run typecheck && npm test && npm run build"
}
```

Keep existing scripts. Do not add dependencies.

- [ ] **Step 2: Commit the lockfile**

Remove `package-lock.json` from `.gitignore`. Run `npm install` to regenerate it if needed. Add it to git.

- [ ] **Step 3: Add CI**

Create `.github/workflows/ci.yml` with Node 22 and 24 matrix, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Use `actions/setup-node@v4` and `actions/checkout@v4`.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: typecheck clean, all tests pass, `dist/cli.js` built.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore .github/workflows/ci.yml README.md
git commit -m "chore: require node 22.18 and add CI"
```

---

### Task 4: Snippets Zed/OpenCode e `--format`

**Files:**
- Create: `src/snippets.ts`
- Test: `test/snippets.test.ts`
- Modify: `src/server.ts:116-125`
- Modify: `src/cli.ts:12-33,42-67`
- Modify: `src/models.ts` (recebe `defaultMaxTokens`)
- Modify: `test/cli.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` com `contextWindow` e `maxTokens`; `defaultMaxTokens` de `src/models.ts`.
- Produces:
  - `export type SnippetFormat = "zed" | "opencode"`
  - `buildZedSnippet(models, port, providerId): unknown`
  - `buildOpenCodeSnippet(models, port, providerId): unknown`

- [ ] **Step 1: Extend `ModelInfo`**

In `src/server.ts`:

```ts
export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
}
```

`fetchModelCatalog()` returns `{ id: m.id, displayName: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens }`.

- [ ] **Step 2: Write failing snippet tests**

```ts
const models = [
  { id: "claude-opus-5-5", displayName: "Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: "claude-opus-5-5:fast", displayName: "Opus 5.5 Fast", contextWindow: 1_000_000, maxTokens: 128_000 },
];

it("builds the Zed snippet", () => {
  const snippet = buildZedSnippet(models, 8124, "claude-code") as any;
  assert.equal(snippet.language_models.openai_compatible["claude-code"].api_url, "http://127.0.0.1:8124/v1");
  assert.equal(snippet.language_models.openai_compatible["claude-code"].available_models[0].max_tokens, 1_000_000);
});

it("builds the OpenCode v2 snippet", () => {
  const snippet = buildOpenCodeSnippet(models, 8125, "claude-code-2") as any;
  const provider = snippet.providers["claude-code-2"];
  assert.equal(provider.settings.baseURL, "http://127.0.0.1:8125/v1");
  assert.equal(provider.models["claude-opus-5-5"].modelID, "claude-opus-5-5");
  assert.equal(provider.models["claude-opus-5-5-fast"].modelID, "claude-opus-5-5:fast");
  assert.deepEqual(provider.models["claude-opus-5-5"].limit, { context: 1_000_000, output: 128_000 });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/snippets.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 4: Implement `src/snippets.ts`**

Move `defaultMaxTokens` from `src/cli.ts` to `src/models.ts` and export it from both (re-export in CLI for the existing test, or update the test import). `snippets.ts` imports it from `models.ts`.

OpenCode key: `m.id.replace(/:fast$/, "-fast").replace(/[^a-zA-Z0-9_.-]/g, "-")`. Capabilities: `{ tools: true, temperature: true, input: ["text", "image"] }`. Name: `Claude (${providerId})`. API key: `"dummy"`.

- [ ] **Step 5: Add `--format` to CLI**

In `parseCliOptions`, parse `--format` with default `"zed"` and throw `Invalid --format value` unless `zed` or `opencode`. Add `format` to `CliOptions`. `printModelsSnippet` calls the matching builder and prints JSON.

Add tests:

```ts
it("defaults to zed format", () => assert.equal(parseCliOptions([]).format, "zed"));
it("accepts opencode format", () => assert.equal(parseCliOptions(["--format", "opencode"]).format, "opencode"));
it("rejects unknown format", () => assert.throws(() => parseCliOptions(["--format", "yaml"]), /format/));
```

- [ ] **Step 6: Run tests**

Run: `node --test test/snippets.test.ts test/cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/snippets.ts src/server.ts src/cli.ts test/snippets.test.ts test/cli.test.ts
git commit -m "feat: add opencode provider snippet format"
```

---

### Task 5: LaunchAgent macOS por instância

**Files:**
- Modify: `scripts/install-mac.sh`
- Test: manual verification documented below

**Interfaces:**
- Produces: label `dev.claude-zed-shim-<port>`; `DRY_RUN=1` prints the plist without installing.

- [ ] **Step 1: Change the label and add migration**

Set `label="dev.claude-zed-shim-$port"` and `old_label="dev.claude-zed-shim"`. On install and uninstall, bootout/remove the old label only when `port=8124`. This preserves an existing 8124 user and avoids touching 8125.

- [ ] **Step 2: Escape XML values**

Add:

```sh
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
```

Use it for `config_dir` and `provider_id` inside the heredoc.

- [ ] **Step 3: Add dry-run before install/build**

```sh
if [ "${DRY_RUN:-}" = "1" ]; then
  printf '%s\n' "$plist_content"
  exit 0
fi
```

Build `plist_content` into a variable or function so dry-run and real install use the same text.

- [ ] **Step 4: Verify**

Run:

```sh
sh -n scripts/install-mac.sh
HOME="$(mktemp -d)" DRY_RUN=1 PORT=8125 CONFIG_DIR='a&b' PROVIDER_ID='claude-code-2' sh scripts/install-mac.sh | grep -E 'dev.claude-zed-shim-8125|a&amp;b|claude-code-2'
```

Expected: one line with the new label, escaped config dir and provider id; no plist written.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-mac.sh
git commit -m "fix: install a separate launch agent per port"
```

---

### Task 6: README e proveniência

**Files:**
- Modify: `README.md`
- Create: `docs/provenance.md`
- Modify: `settings.example.json`

**Interfaces:**
- Produces: documentação operacional para duas contas em Zed e OpenCode.

- [ ] **Step 1: Write `docs/provenance.md`**

Mapa:

- `antigravity-zed-shim`: HTTP/SSE, CLI, instaladores, runners, snippet `settings.json`.
- `opencode-antigravity-auth`: vendor do shim Antigravity; storage, catálogo, multi-conta, recovery.
- `opencode-claude-legacy`: sessões, bridge, usage, modelos, SDK.
- Código novo do shim: partição por config dir, provider id, formato OpenCode.

Inclua os ranges de origem que já foram identificados no spec.

- [ ] **Step 2: Update README**

Adicionar:

- dois providers no Zed com portas 8124/8125 e `provider-id`;
- snippet OpenCode v2 com `providers.<id>`;
- comando `npm run models -- --format opencode`;
- aviso de uma instância por config dir;
- migração do LaunchAgent antigo;
- Node 22.18+;
- troubleshooting de sessão/usage.

- [ ] **Step 3: Update `settings.example.json`**

Adicionar o segundo provider `claude-code-2` em `127.0.0.1:8125`, sem modelo fixo obrigatório. Manter o primeiro.

- [ ] **Step 4: Verify links and snippets**

Run:

```sh
node dist/cli.js models --format opencode | jq '.providers | keys'
node dist/cli.js models --format zed | jq '.language_models.openai_compatible | keys'
```

Expected: provider ids corretos; JSON válido.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/provenance.md settings.example.json
git commit -m "docs: document two-account Zed and OpenCode setup"
```
