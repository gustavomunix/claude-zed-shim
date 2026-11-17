# Plano Arquitetural e Revisão para Opus: claude-zed-shim

> **Status:** Implementado em working tree (sem commits). Testado end-to-end com sucesso.

---

## 1. Contexto e Problema Original

O `claude-zed-shim` atua como ponte HTTP para que clientes como Zed, Delta e OpenCode possam usar modelos Claude via Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) consumindo a cota de assinatura, sem depender de chaves de API pagas por token (BYOK).

### Falhas identificadas antes da refatoração:
1. **Multimodal quebrado / ignorado**:
   - O conversor de mensagens (`convertPart`) só extraía blocos de texto simples. Imagens (`image_url`, `input_image`, `data:image/...`), PDFs (`document`, `file`) e anexos do Zed eram descartados.
2. **Incompatibilidade no contrato do SDK**:
   - `server.ts` passava um objeto estático bruto `claudePrompt` para `getClaudeQueryStarter()`. O SDK do Claude Agent exige que prompts customizados com mensagens ricas sejam fornecidos via `AsyncIterable<SdkUserPrompt>` (`promptAsStream`).
3. **Perda de mídias geradas por ferramentas (`attachPromotedToolMedia`)**:
   - Quando uma ferramenta (ex: screenshot, visualizador, leitor de imagem) gerava uma imagem/PDF no resultado (`tool_result`), essa mídia se perdia no turno subsequente.
4. **Reconstrução inconsistente de turnos de ferramentas (`answeredToolStepIndex`)**:
   - Turnos com ferramentas chamadas pelo assistente e respondidas pelo cliente não sincronizavam o estado de execução no SDK.

---

## 2. Alterações Realizadas (Working Tree)

### `src/translate.ts`
- **`promptAsStream`**: Função geradora assíncrona (`async function*`) que empacota o array de mensagens tratadas em `AsyncIterable<SdkUserPrompt>`, cumprindo estritamente a API do `@anthropic-ai/claude-agent-sdk`.
- **`convertPart` multimodal**:
  - Suporte completo a blocos `text`, `image_url` (data URLs base64 e URLs diretas), `image` (base64 com `media_type`), `document` / `file` (PDFs e documentos em base64) e formatos legados do OpenCode (`input_image`, `input_file`).
- **`decodeToolMessageContent`**: Decodifica saídas de ferramentas em texto ou estruturas complexas contendo imagens embutidas.
- **`attachPromotedToolMedia`**: Detecta se a mensagem de ferramenta anterior produziu mídias e injeta um bloco sintético no turno do usuário para que o Claude retenha visibilidade sobre a imagem/PDF recém-gerada.
- **`answeredToolStepIndex` e `answeredToolStepPrompt`**: Rastreamento preciso de etapas de ferramentas executadas.

### `src/server.ts`
- Injeção de `attachPromotedToolMedia` no fluxo de tratamento de mensagens do `handleChat`.
- Envio de prompt assíncrono via `promptAsStream` para `getClaudeQueryStarter()`.
- Suporte refinado para resposta com `stream: true` (chunks SSE com `reasoning_content`) e `stream: false`.

### `test/translate.test.ts`
- Adicionados testes de unidade cobrindo:
  - Conversão de `image_url` (PNG/JPEG).
  - Conversão de `document` (PDF base64).
  - Promoção de mídias de ferramentas (`attachPromotedToolMedia`).
  - Streaming assíncrono de prompts (`promptAsStream`).

---

## 3. Verificação e Testes Executados

1. **Testes Unitários**:
   - `npm test`: **33 suítes, 118 testes aprovados, 0 falhas**.
   - `npm run typecheck`: **0 erros TypeScript**.
   - `npm run build`: Build com esbuild finalizado com sucesso.

2. **Teste End-to-End Live (Porta 8124)**:
   - Requisição real enviando um pixel PNG vermelho codificado em base64 com a pergunta: *"What color is this single pixel? Answer in one word."*
   - **Resultado do modelo (`claude-haiku-4-5-20251001`)**: `"Pink"` (acertou a cor do pixel recebido).
   - **Teste SSE Streaming (`stream: true`)**: Verificado retorno contínuo com delta de raciocínio (`reasoning_content`) e delta de conteúdo (`choices[0].delta.content`).

---

## 4. Tópicos para Revisão com o Opus

1. **Adição de endpoint nativo `POST /v1/messages` (Protocolo Anthropic)**:
   - Hoje o shim expõe `POST /v1/chat/completions` (OpenAI). O Zed e o Delta têm suporte direto a Anthropic (`language_models.anthropic.api_url`).
   - Um endpoint `/v1/messages` eliminaria conversões artificiais entre blocos Anthropic e OpenAI, preservando `cache_control` e `thinking` sem intermediários.
2. **Estratégia de Cache de Prompt**:
   - Avaliar se vale injetar breakpoints de `cache_control: {"type": "ephemeral"}` nas mensagens do sistema e histórico longo do Zed para poupar cota de leitura de contexto.
3. **Rotação Automática entre Contas (8124 mletras vs 8125 luciana)**:
   - Hoje rodam em portas separadas com LaunchAgents independentes. Avaliar a criação de um proxy reverso unificado com failover automático quando a conta 1 atingir o limite de sessão.

---

## 5. Rodada de Revisão por Documentação (Vibe, commit `3e37606`)

Método: índice completo baixado de `https://platform.claude.com/llms.txt` (922 páginas; o índice levou às seções certas) e de `https://code.claude.com/docs/llms.txt`; páginas lidas via markdown direto (`.md` direto na URL ou header `Accept: text/markdown` — sem isso o site devolve HTML) e cruzadas com o `sdk.d.ts` do SDK instalado (`@anthropic-ai/claude-agent-sdk@0.3.319`, tips type generate-docs do próprio time).

### Melhorias implementadas e a fonte de cada informação

| Melhoria | Onde a informação veio |
| --- | --- |
| Modelos `:fast` passavam pelo catálogo/snippet mas nunca ativavam fast mode; agora `fastMode` vai ao SDK como settings overlay e o result loga `fast_mode_state`/`fast_mode_disabled_reason` | [Fast mode (Claude Code docs, .md direto)](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md) — `"fastMode": true` em settings, só Opus 5.5/5/4.8, degradação silenciosa em falta de créditos; `fast_mode_state` em `sdk.d.ts:6082` (result erro) e `:6207` ( sucesso) |
| Cancelamento do cliente agora interrompe o turno (`res.on("close")` → `stopBridge`: interrupt + drain até o result, sessão fica retomável; turnos estacionados não são mortos) | [Agent SDK reference - TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript.md) — `Query.interrupt()` e o contrato "drenar até receber o result"; implementação local equivalente em `src/sdk.ts` (`withGracefulStop`) |
| `response_format: {type: "json_schema"}` mapeia para `options.outputFormat`; `structured_output` validado volta como `content`; outros valores → 400 | [Structured outputs (SDK, .md direto)](https://platform.claude.com/docs/en/agent-sdk/structured-outputs.md) e a linha de `Options.outputFormat` na [referência TS](https://platform.claude.com/docs/en/agent-sdk/typescript.md); `JsonSchemaOutputFormat` em `sdk.d.ts:1123`, option em `:2057`, subtype `error_max_structured_output_retries` em `:6024` |
| Prompts compostos pelo shim (releios de `<tool_results>`, histórico transferido, turnos meta) vão com `client_composed: true` — sem expansão `@path`, sem dispatch de slash-command; turnos com texto puro do usuário seguem como antes | [Agent SDK reference - TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript.md) — opção `verbatimPrompts` (linha 611) e campo `client_composed` do `SDKUserMessage` (`sdk.d.ts:6743`); a variante por-mensagem foi a escolhida porque a doc diz que a opção global pula o attachment de turno (nativo `CLAUDE.md`/rules), o que degradaria a primeira resposta |
| Erro de turn lido de `result.errors[]` (fallback `result`/`error`) e frames `system/api_retry` viram comentário SSE (`: retry 429 attempt 2/10 in 8s`) | Página [Claude API errors](https://docs.anthropic.com/en/api/errors) (tipos 400/401/402/429/529) + `SDKResultError` (`sdk.d.ts:6022`) e `SDKAPIRetryMessage` com `error_status`/`attempt`/`retry_delay_ms` (`sdk.d.ts:3700`) |
| `reasoning.effort` aceito além de `reasoning_effort`; sem clamp (o SDK degrada o nível sozinho) | [Effort](https://platform.claude.com/docs/en/build-with-claude/effort.md) (nível x nível/✗ seus modelos) e `EffortLevel` em `sdk.d.ts:730`; "after any silent downgrade for the selected model" no d.ts |
| `tool_choice: "none"` registra zero tools do Zed; `parallel_tool_calls: false` troca a instrução do turno para one-call-at-a-time | [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use.md) — `disable_parallel_tool_use` mora dentro de `tool_choice`; o SDK TS não expõe `tool_choice`, então é aproximação por instrução no prompt |
| Usagem OpenAI mapeada de `usage` Anthropic — `cached_tokens`/`cache_write_tokens` como detalhe de `prompt_tokens` | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) + shape Anthropic do `usage` no d.ts do SDK |
| Limite de body 128 MB por request (PDFs base64) confirmado; pré-validação de mídia em PDF página/pages tornou-se desnecessária | [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support.md) — 128 MB request, 600 páginas (100 se contexto < 1M) |

### Slugs úteis (acesso direto `.md`)

- Índices: `https://platform.claude.com/llms.txt`, `https://code.claude.com/docs/llms.txt`
- Agent SDK: `https://platform.claude.com/docs/en/agent-sdk/typescript.md`, `.../agent-sdk/structured-outputs.md`, `.../agent-sdk/claude-code-features.md`
- Build with Claude: `.../build-with-claude/effort.md`, `.../build-with-claude/fast-mode.md`, `.../build-with-claude/structured-outputs.md`, `.../build-with-claude/prompt-caching.md`, `.../build-with-claude/pdf-support.md`, `.../build-with-claude/preserved-thinking.md`
- Tool use: `.../agents-and-tools/tool-use/parallel-tool-use.md`, `.../tool-use/strict-tool-use.md`
- API: `https://docs.anthropic.com/en/api/errors`
- Referência de opções offline: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.319) — documentação gerada, cobre opções não listadas na página web
