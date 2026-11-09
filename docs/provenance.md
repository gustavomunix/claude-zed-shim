# Provenance

O `claude-zed-shim` é um port seletivo de três referências. Este arquivo existe para que uma mudança futura saiba o que veio de onde e o que foi deliberadamente deixado de fora.

## Referências

### `antigravity-zed-shim`

Origem da casca Zed:

- HTTP local, SSE e JSON: `src/server.ts`.
- CLI `serve/models/status/self-test`: `src/cli.ts`.
- Instaladores, runners e `settings.example.json`.
- Formato do snippet `language_models.openai_compatible`.
- `antigravity-zed-shim/src/translate.ts`: `openAICompletion`, `openAIError`, `openAIStreamChunk`, `openAIUsageChunk`.

O shim troca o upstream Antigravity pelo Claude Agent SDK, mas mantém a forma do provider e a disciplina de rodar em `127.0.0.1`.

### `opencode-antigravity-auth`

Upstream vendorizado do `antigravity-zed-shim`, não copiado para o shim Claude. Contribuiu indiretamente com:

- catálogo dinâmico de modelos e cache;
- ideia de multi-conta por processo/arquivo;
- classificação e recuperação de erros;
- escrita atômica de storage (`src/plugin/storage.ts:735-808`);
- seleção sticky de conta (`src/plugin/accounts.ts:296-305`);
- recuperação de `tool_result_missing` (`src/plugin/recovery.ts:86-159`).

O que não se aplica ao Claude: OAuth Google, refresh de token, quota Antigravity, transformação Gemini, schema cleaning e thinking recovery.

### `opencode-claude-legacy`

Origem do motor Claude:

- `auth.ts`, `cli-path.ts`, `env.ts`, `models.ts`, `pool.ts`, `sdk.ts`.
- `store.ts` e `pool.ts`: bindings de sessão e bridges parkeadas.
- `translate.ts`: conversão de mensagens, histórico, erros e usage.
- `server.ts`: mapeamento de eventos do Agent SDK.
- Futuro port: `session-transcript.ts`, `resume.ts`, `usage.ts`, `request-kind.ts`.

Ranges de referência:

- sessões: `src/session-store.ts:195-301,309-480,522-540`;
- resume/rewind/fork: `src/proxy.ts:1286-1425`;
- usage: `src/usage.ts:280-385`;
- tool bridge: `src/proxy.ts:1977-2025,2152-2225`;
- finish/narração: `src/proxy.ts:3005-3007,3087-3094,3163-3299`;
- meta requests: `src/request-kind.ts:68-82`, `src/proxy.ts:1504-1685`.

## Código novo

Não vem de referência:

- partição de `sessions.json`/`models.json` por `CLAUDE_CONFIG_DIR`;
- `--provider-id` e `--format opencode`;
- snippet OpenCode v2;
- LaunchAgent por porta;
- port seletivo de sessão/usage para o servidor Zed.

## Regra

Ao portar uma função do `opencode-claude-legacy`, porte também o teste de regressão correspondente. O erro da v1 foi copiar tipos e funções sem a máquina de estados e sem os testes.
