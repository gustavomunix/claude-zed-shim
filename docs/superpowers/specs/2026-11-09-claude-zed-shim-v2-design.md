# Claude Zed Shim v2 — Design

**Data:** 2026-11-09
**Status:** proposta para revisão
**Repositório:** `claude-zed-shim`

## Objetivo

Transformar o shim atual em uma ponte confiável entre Claude Code e dois clientes:

- **Zed:** duas contas Claude como dois providers `openai_compatible`, cada uma em sua porta e `CLAUDE_CONFIG_DIR`.
- **OpenCode:** conta nativa do OpenCode + shim como segundo provider; opcionalmente duas instâncias do shim.

O shim continua sendo um processo local OpenAI-compatible. Ele não faz OAuth, não lê tokens e não troca de conta dentro do mesmo processo.

## Contexto atual

O shim nasceu como adaptação de três referências:

- `antigravity-zed-shim`: casca Zed (HTTP/SSE, CLI, instaladores, runners, snippet `settings.json`).
- `opencode-antigravity-auth`: upstream vendorizado do shim Antigravity; padrões de storage, catálogo, multi-conta e recuperação.
- `opencode-claude-legacy`: motor Claude (Agent SDK, sessões, tool bridge, usage, modelos).

O port atual é seletivo e incompleto. Tipos do motor Claude chegaram, mas parte da máquina de estados, usage e testes ficou para trás.

Problemas confirmados:

| Área | Problema |
|---|---|
| Sessão | `recordTurnStart` nunca chamado; `matchTurnHistory` incompatível com o formato dos boundaries; sem fork/rewind; sem fallback para transcript apagado |
| Instruções | `isolateMcp` força `settingSources: []`; `CLAUDE.md`/`AGENTS.md` do projeto não carregam |
| Tool bridge | sem `readOnlyHint`; `coerceStringArgument` morto; `fitToolDescription` corta lista de subagentes |
| Usage | streaming sem usage; non-stream soma eventos duplicados |
| Finish | `finish_reason` sempre `stop`/`tool_calls`; `max_tokens` e refusal ignorados |
| Meta requests | title/summary/commit do Zed viram turno completo de agente |
| Multi-conta | LaunchAgent macOS com label fixo; segundo install sobrescreve o primeiro |
| Persistência | `writeFileSync` direto; crash no meio do write perde `sessions.json` em silêncio |
| Base | Node mínimo errado para os testes; lockfile ignorado; sem CI |

## Goals

1. Duas contas Claude funcionando simultaneamente no Zed.
2. OpenCode com provider nativo + shim, e snippet de configuração gerado pelo CLI.
3. Resume, rewind, fork e transferência de histórico corretos.
4. Usage e `finish_reason` compatíveis com Zed em SSE e JSON.
5. Ferramentas do Zed com paralelismo, coerção de argumentos e descrições completas.
6. Instruções do projeto (`CLAUDE.md`/`AGENTS.md`) carregadas.
7. Title, summary e commit message do Zed rodando como turnos utilitários baratos.
8. Persistência atômica, logs de diagnóstico, instaladores multi-conta.
9. Testes de regressão portados das referências e CI.

## Non-goals

- Troca automática de conta por requisição ou rotação de quota.
- OAuth, refresh de token ou leitura de credenciais.
- Empacotar o shim como plugin do OpenCode.
- Alterar o Zed ou o Claude Code.
- Portar transformações Gemini/Antigravity, schema cleaning ou thinking recovery do plugin Antigravity.
- Portar steering, cache warming, Code Mode, compactação do OpenCode sem equivalente no Zed.
- Fazer o shim ser um provider nativo Anthropic.

## Approaches consideradas

### A. Vendor completo do `opencode-claude-legacy`

Copiar `session-store.ts`, `usage.ts`, partes de `proxy.ts` e testes para `vendor/`, com uma seam de adaptação.

Prós: lógica e testes já provados; atualização upstream mais clara.
Contras: 9.5k linhas, forte acoplamento a OpenCode, muitas partes inúteis; o bundle e a manutenção crescem.

### B. Port seletivo da máquina de estados para os módulos atuais

Portar `session-store`, helpers de transcript, `usage`, `request-kind` e as opções de tool bridge para arquivos focados; adaptar o servidor Zed.

Prós: mantém a casca enxuta, reaproveita o que importa, permite testes de regressão.
Contras: sync manual com as referências; exige portar os testes junto para não repetir o problema atual.

### C. Limpeza mínima

Apagar `turns`/`leafUuid`/`reportedUsage`, documentar que não há rewind nem usage, corrigir só multi-conta e instaladores.

Prós: menor esforço; shim fica honesto.
Contras: não atende o objetivo de "arrumar tudo"; perde contexto ao editar/regenerar e não melhora custo/telemetria.

**Escolha: B.** O port seletivo é o único que entrega o escopo completo sem transformar o projeto em um fork do plugin OpenCode.

## Arquitetura

### Multi-conta

Uma instância por conta. O processo recebe `CLAUDE_CONFIG_DIR` via `--config-dir` ou ambiente. `configBucket()` deriva um hash do caminho e particiona:

- `sessions.json`
- `models.json`

O `--provider-id` nomeia o provider no Zed/OpenCode; não troca a conta do processo.

Zed:

```json
{
  "language_models": {
    "openai_compatible": {
      "claude-code": {
        "api_url": "http://127.0.0.1:8124/v1",
        "available_models": []
      },
      "claude-code-2": {
        "api_url": "http://127.0.0.1:8125/v1",
        "available_models": []
      }
    }
  }
}
```

OpenCode v2:

```json
{
  "providers": {
    "claude-luciana": {
      "name": "Claude (Luciana)",
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

O provider nativo do OpenCode cobre a primeira conta; o shim cobre a segunda. Duas instâncias do shim também são suportadas.

### Sessão

O armazenamento continua compatível com `sessions.json`. Cada binding guarda:

```ts
type TurnBoundary = {
  count: number;
  hash: string;
  leafUuid?: string;
  sessionId?: string;
};

type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  leafUuid?: string;
  turns?: TurnBoundary[];
  updatedAt: number;
};
```

Fluxo de uma requisição de chat:

1. Calcula `conversationKey`.
2. Carrega binding e transcript Claude.
3. Compara fingerprints do histórico com `matchTurnHistory`.
4. Decide:
   - `latest`: resume e injeta só as mensagens que a sessão não viu.
   - `rewind` com leaf: volta boundaries e faz fork se a chain não estiver limpa.
   - `rewind` sem leaf: resume a sessão inteira.
   - `diverged`: limpa binding e transfere o histórico como texto.
   - `untracked`: resume sem injetar nada.
5. Registra o boundary do turno antes de iniciar a query.
6. Atualiza `session_id`/`leafUuid` a cada evento.

O planejamento fica em `src/resume.ts` como função pura testável. O servidor executa I/O e fork.

### Usage

`TurnUsageTracker` porta a semântica do ref:

- usage por `messageId`;
- `message_start`/`message_delta`/`assistant` não contam duas vezes;
- continuação de turno parkeado reporta só o crescimento;
- prompt tokens representam o contexto da última chamada, não a soma;
- `result` é fallback, não soma.

O chunk final SSE leva `finish_reason` e `usage` no mesmo objeto. Zed aborta a conexão se receber um chunk só de usage com `choices: []`.

### Tool bridge

- Ferramentas em `PARALLEL_SAFE_TOOLS` recebem `annotations: { readOnlyHint: true }`.
- Schemas com tipos não-string recebem `z.preprocess` usando `coerceStringArgument`.
- `fitToolDescription` move a lista de subagentes para o início antes do corte.
- O limite vem de `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` ou 8192.

### Instruções e meta requests

Chat: `settingSources: ["project"]` com `isolateMcp: true`. Isso carrega `CLAUDE.md`/`AGENTS.md` do projeto, mantendo hooks desligados, MCP estrito e settings de usuário fora.

Meta requests detectados pelo system prompt do Zed:

- title: `Generate a concise 3-7 word title for this conversation`
- summary: `Summarize the conversation so far to free up context` ou `Compact the conversation so far.`
- commit: `You are an expert at writing Git commits.`

Turno meta:

- `persistSession: false`
- `maxTurns: 1`
- `thinking: { type: "disabled" }`
- `settingSources: []`
- `skills: []`
- `autoCompactEnabled: false`
- sem MCP e sem tools
- system prompt utilitário
- prompt contém instruções do system + conteúdo do usuário

### Persistência

Novo helper `src/json-file.ts` grava com arquivo temporário + `rename`. `store.ts` e `models.ts` passam a usá-lo. Não haverá lock entre processos; o desenho é uma instância por config dir. Se duas instâncias compartilharem o mesmo diretório, a última escrita vence, mas o arquivo nunca fica corrompido.

### Observabilidade

`CLAUDE_ZED_DEBUG=1` escreve uma linha JSON por evento em stderr:

- request recebido (modelo, provider, conta);
- decisão de resume;
- park/resume de tools;
- erro classificado;
- usage final.

Sem tokens, prompts completos ou credenciais.

## File Structure

Novos:

- `src/json-file.ts` — leitura/escrita atômica de JSON.
- `src/log.ts` — log de debug opt-in.
- `src/session-transcript.ts` — leitura de `.jsonl` do Claude Code.
- `src/resume.ts` — planejamento puro de resume/rewind/fork.
- `src/usage.ts` — tracker de usage.
- `src/request-kind.ts` — detecção de title/summary/commit do Zed.
- `src/snippets.ts` — snippets Zed e OpenCode.
- `docs/provenance.md` — mapa das referências.
- `test/json-file.test.ts`
- `test/session-store.test.ts`
- `test/session-transcript.test.ts`
- `test/resume.test.ts`
- `test/usage.test.ts`
- `test/request-kind.test.ts`
- `test/snippets.test.ts`
- `test/server-session.test.ts`
- `test/server-protocol.test.ts`
- `test/tool-bridge-options.test.ts`
- `test/helpers/server.ts`

Modificados:

- `src/store.ts` — boundaries, merge, match, rewind.
- `src/server.ts` — resume plan, meta requests, usage, finish, cleanup.
- `src/sdk.ts` — query starter injetável, `settingSources`.
- `src/tool-bridge.ts` — annotations, coercion, description.
- `src/translate.ts` — usage/finish helpers, refusal note.
- `src/cli.ts` — `--format`, provider id, status.
- `src/models.ts` — cache atômico, `ModelInfo` completo.
- `package.json`, `.gitignore`, `README.md`, `settings.example.json`.
- `scripts/install-mac.sh`, `scripts/install.ps1`.
- `start-windows.cmd`, `start-silent.vbs` (se necessário para provider id).

## Interfaces Principais

```ts
// json-file.ts
export function readJsonFile<T>(path: string): T | null;
export function writeJsonFileAtomic(path: string, value: unknown): void;

// store.ts
export function matchTurnHistory(turns: TurnBoundary[], prints: string[]): HistoryMatch;
export function recordTurnStart(
  conversationKey: string,
  boundary: { count: number; hash: string },
  before?: { count: number; hash: string },
): void;

// session-transcript.ts
export function findClaudeSessionFile(sessionId: string, configDir?: string): string | null;
export function sessionFileHasEntry(file: string, uuid: string): boolean;
export function sessionChainAfterLeaf(file: string, leafUuid: string): LeafChainState;
export function lastChainEntryUuid(file: string): string | undefined;

// resume.ts
export function planResume(input: ResumeInput): ResumePlan;

// usage.ts
export class TurnUsageTracker {
  constructor(reported: Map<string, OpenAIUsage>);
  add(usage: OpenAIUsage, messageId: string | null): void;
  total(): OpenAIUsage | null;
}

// request-kind.ts
export function detectMetaRequestKind(messages: HistoryMessage[]): MetaRequestKind;
export function buildMetaPrompt(kind: Exclude<MetaRequestKind, null>, messages: HistoryMessage[]): string;

// snippets.ts
export function buildZedSnippet(models: ModelInfo[], port: number, providerId: string): unknown;
export function buildOpenCodeSnippet(models: ModelInfo[], port: number, providerId: string): unknown;
```

## Constraints

- Node `>=22.18.0` para `node --test` com TypeScript.
- Nenhuma credencial lida, copiada ou logada.
- `127.0.0.1` apenas.
- `sessions.json` existente deve continuar legível; bindings antigos sem `turns` são `untracked`.
- Nenhuma dependência nova além de `proper-lockfile` se o lock for realmente adotado; o plano usa só escrita atômica.
- `package-lock.json` versionado.
- Testes existentes continuam passando.

## Acceptance Criteria

1. `npm test`, `npm run typecheck` e `npm run build` passam em Node 22.18+.
2. Duas instâncias do shim, com config dirs distintos, respondem `/health` e mantêm `sessions.json`/`models.json` separados.
3. `install-mac.sh` com `PORT=8125` cria `dev.claude-zed-shim-8125.plist` e não remove a instância 8124.
4. `models --format opencode` imprime bloco válido para OpenCode v2.
5. Um turno com `session_id` existente faz resume; um turno após edição faz rewind/fork; um transcript apagado transfere histórico.
6. Streaming emite usage no chunk final; `finish_reason` reflete `max_tokens`/refusal.
7. `CLAUDE.md` do projeto aparece nas opções da query.
8. Title/summary/commit não criam sessão persistente nem usam tools.
9. Ferramentas read-only recebem `readOnlyHint`; argumentos string são coercionados; lista de subagentes sobrevive ao corte.
10. Log de debug mostra a decisão de resume sem vazar conteúdo sensível.

## Riscos

- Os markers de title/summary/commit do Zed podem mudar entre versões; os testes usam os textos observados no binário atual e o código deve ser tolerante a variações.
- `settingSources: ["project"]` carrega `.claude/settings.json` do projeto. Hooks ficam desligados e MCP estrito; ainda assim, revisar permissões.
- Fork depende de `forkSession` do SDK e do arquivo `.jsonl`; se o arquivo sumir, o plano cai para transferência de histórico.
- Duas instâncias no mesmo config dir não terão lock; documentar como configuração não suportada.
- O Zed não envia session header; dois chats no mesmo projeto com a mesma primeira mensagem e modelo ainda colidem na `conversationKey`. Isso fica documentado como limitação conhecida.

## Decisão

Seguir o port seletivo (Approach B), em quatro planos:

1. Fundação e multi-conta.
2. Máquina de sessão.
3. Protocolo, usage, tools, instruções e meta.
4. Endurecimento, testes de integração e release.
