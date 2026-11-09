# Claude Zed Shim v2 — Protocol and Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir usage, `finish_reason`, narração, tool bridge, instruções do projeto e meta requests do Zed.

**Architecture:** `usage.ts` faz a contabilidade por mensagem e por continuação de bridge. O servidor emite um único chunk final com `finish_reason` + `usage`. O tool bridge adiciona anotações e coerção. Chat carrega `settingSources: ["project"]`; title/summary/commit rodam como turnos utilitários sem sessão.

**Tech Stack:** TypeScript, Agent SDK, Zod, SSE OpenAI.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-zed-shim-v2-design.md`

## Global Constraints

- Usage nunca pode contar a mesma chamada duas vezes entre park e resume.
- Chunk final SSE leva `choices[0].finish_reason` e `usage` juntos.
- Meta requests não persistem sessão e não usam tools.
- Chat mantém `isolateMcp: true` e passa `settingSources: ["project"]`.
- Nenhuma ferramenta de escrita recebe `readOnlyHint`.

## Review Focus

- Streaming parkeado não pode perder usage nem duplicar no resume.
- `max_tokens` e refusal precisam aparecer como `length`/`content_filter`.
- Argumentos string em schema numérico/booleano não podem falhar antes do callback.
- Descrição longa de subagente não pode perder a lista de agentes.
- `CLAUDE.md` do projeto não pode deixar de carregar por causa de `isolateMcp`.
- Title/summary/commit não podem criar sessão no `sessions.json`.

---

### Task 1: `TurnUsageTracker`

**Files:**
- Create: `src/usage.ts`
- Test: `test/usage.test.ts`
- Modify: `src/translate.ts:439-464`
- Modify: `src/pool.ts:4-15`

**Interfaces:**
- Produces:

```ts
export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export function addUsage(a: OpenAIUsage | null, b: OpenAIUsage): OpenAIUsage;
export function maxUsage(a: OpenAIUsage, b: OpenAIUsage): OpenAIUsage;
export function usageGrowth(max: OpenAIUsage, baseline: OpenAIUsage | null): OpenAIUsage | null;
export function resolveTurnUsage(accumulated: OpenAIUsage | null, result: OpenAIUsage | null): OpenAIUsage | null;
export class TurnUsageTracker {
  constructor(reported: Map<string, OpenAIUsage>);
  add(usage: OpenAIUsage, messageId: string | null): void;
  total(): OpenAIUsage | null;
}
```

- [ ] **Step 1: Write failing tests**

```ts
it("keeps the max of message_start and message_delta", () => {
  const reported = new Map<string, OpenAIUsage>();
  const tracker = new TurnUsageTracker(reported);
  tracker.add({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }, "m1");
  tracker.add({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, "m1");
  assert.deepEqual(tracker.total(), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

it("reports only growth across a resumed bridge", () => {
  const reported = new Map<string, OpenAIUsage>([
    ["m1", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }],
  ]);
  const tracker = new TurnUsageTracker(reported);
  tracker.add({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }, "m1");
  assert.deepEqual(tracker.total(), { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

it("sums completions across calls but takes the last prompt", () => {
  const tracker = new TurnUsageTracker(new Map());
  tracker.add({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, "m1");
  tracker.add({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }, "m2");
  assert.deepEqual(tracker.total(), { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 });
});

it("falls back to the result usage", () => {
  assert.deepEqual(
    resolveTurnUsage(null, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }),
    { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/usage.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

Port the accounting from `opencode-claude-legacy/src/usage.ts:280-385`, reduced to the fields above. `total()` sums completion growth and applies the last call's prompt via `withPromptOf`.

Change `src/translate.ts` `usageFromAnthropic` to return `OpenAIUsage` (same three fields). Change `src/pool.ts` `reportedUsage` to `Map<string, OpenAIUsage>`.

- [ ] **Step 4: Run tests**

Run: `node --test test/usage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts src/translate.ts src/pool.ts test/usage.test.ts
git commit -m "feat: track claude usage across parked turns"
```

---

### Task 2: Integrar usage no JSON e no SSE

**Files:**
- Modify: `src/server.ts:720-753`
- Modify: `src/server.ts:659-718`
- Test: `test/server-protocol.test.ts`

**Interfaces:**
- Consumes: `TurnUsageTracker`, `resolveTurnUsage`.
- Produces: `usage` no corpo JSON e no chunk final SSE.

- [ ] **Step 1: Write failing stream test**

Use the helper from the session plan. Fake events:

```ts
yield { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1 } } } };
yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } };
yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 4 } } };
yield { type: "result", is_error: false, usage: { input_tokens: 10, output_tokens: 4 } };
```

Parse SSE and assert the last data chunk has:

```ts
assert.equal(last.choices[0].finish_reason, "stop");
assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
```

Also assert there is no chunk with `choices: []`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server-protocol.test.ts`
Expected: FAIL; final chunk has no usage.

- [ ] **Step 3: Implement**

In `relayStreamToResponse`:

- create `const tracker = new TurnUsageTracker(bridge.reportedUsage)`;
- `usage-delta` → `tracker.add(mapped.usage, mapped.messageId)`;
- `usage` → `resultUsage = mapped.usage`;
- before final chunk: `const usage = resolveTurnUsage(tracker.total(), resultUsage)`;
- emit **one** final chunk with `finish_reason` and `...(usage ? { usage } : {})`.

In `collectTurnResponse`, replace the manual sums with the same tracker and `resolveTurnUsage`.

- [ ] **Step 4: Run tests**

Run: `node --test test/server-protocol.test.ts test/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-protocol.test.ts
git commit -m "fix: emit usage in streaming and non-streaming responses"
```

---

### Task 3: `finish_reason` e narração

**Files:**
- Modify: `src/translate.ts:361-387`
- Modify: `src/server.ts:172-259,669-709`
- Test: `test/server-protocol.test.ts`
- Test: `test/translate.test.ts`

**Interfaces:**
- Produces:
  - `finishReasonFor(stopReason: string | null | undefined): "stop" | "length" | "content_filter"`
  - `openAICompletion(..., usage, stopReason?)`

- [ ] **Step 1: Write failing tests**

```ts
it("maps max_tokens to length", () => {
  assert.equal(finishReasonFor("max_tokens"), "length");
});
it("maps refusal to content_filter", () => {
  assert.equal(finishReasonFor("refusal"), "content_filter");
});
it("keeps tool_calls when parked", () => {
  assert.equal(finishReasonFor("tool_use"), "stop");
});
```

Stream test: yield `message_delta` with `delta.stop_reason: "max_tokens"` and assert final `finish_reason === "length"`.

Narration test:

```ts
assert.equal(isNarrationSignature(Buffer.from("narration:hello").toString("base64")), true);
assert.equal(isNarrationSignature(Buffer.from("thinking").toString("base64")), false);
```

Export `isNarrationSignature` for the test.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server-protocol.test.ts test/translate.test.ts`
Expected: FAIL; finish reason always stop and narration always false.

- [ ] **Step 3: Implement**

- In `mapSdkEvent`, set `state.stopReason` from `ev.delta.stop_reason` on `message_delta` when `parent_tool_use_id` is absent; set it from `result.stop_reason` before the `is_error` branch.
- Streaming final: `finishReason = toolCalls.length > 0 ? "tool_calls" : finishReasonFor(mapState.stopReason)`.
- When a mapped error carries `state.stopReason === "refusal"` after content, keep `finish_reason: "content_filter"` instead of forcing `"stop"`.
- `openAICompletion` gains optional `stopReason`; finish reason is `tool_calls` or `finishReasonFor(stopReason)`.
- `isNarrationSignature` decodes base64 and checks `"narration"` in the first 64 bytes.

- [ ] **Step 4: Run tests**

Run: `node --test test/server-protocol.test.ts test/translate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/translate.ts src/server.ts test/server-protocol.test.ts test/translate.test.ts
git commit -m "fix: map claude stop reasons and narration"
```

---

### Task 4: `readOnlyHint` nas ferramentas paralelas

**Files:**
- Modify: `src/tool-bridge.ts:38-52,110-177`
- Test: `test/tool-bridge-options.test.ts`

**Interfaces:**
- Produces:
  - `export type ListedZedTool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint: true }; _meta: Record<string, unknown> }`
  - `export function describeZedTools(tools: ZedOpenAITool[]): ListedZedTool[]`

- [ ] **Step 1: Write failing test**

```ts
const tools = [
  tool("read"), tool("webfetch"), tool("edit"),
];
const listed = describeZedTools(tools);
assert.equal(listed.find((t) => t.name === "read")?.annotations?.readOnlyHint, true);
assert.equal(listed.find((t) => t.name === "webfetch")?.annotations?.readOnlyHint, true);
assert.equal(listed.find((t) => t.name === "edit")?.annotations, undefined);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: FAIL with missing `describeZedTools`.

- [ ] **Step 3: Implement**

Extract the `listed.push` logic into `describeZedTools`. Add annotations only when `PARALLEL_SAFE_TOOLS.has(name)`. Use the same list in `buildZedMcpServer`.

- [ ] **Step 4: Run tests**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-bridge.ts test/tool-bridge-options.test.ts
git commit -m "feat: mark read-only zed tools for parallel execution"
```

---

### Task 5: Coerção de argumentos string

**Files:**
- Modify: `src/tool-bridge.ts:71-91,126-165`
- Test: `test/tool-bridge-options.test.ts`

**Interfaces:**
- Produces: `withStringCoercion(shape: unknown, schema: Record<string, unknown>): unknown`

- [ ] **Step 1: Write failing test**

```ts
const shape = z.fromJSONSchema({ type: "object", properties: { count: { type: "number" } } }).loose();
const coerced = withStringCoercion(shape, { type: "object", properties: { count: { type: "number" } } });
assert.deepEqual(coerced.parse({ count: "5" }), { count: 5 });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: FAIL with missing `withStringCoercion`.

- [ ] **Step 3: Implement**

Port `withStringCoercion` from `opencode-claude-legacy/src/proxy.ts:2152-2185` using `coerceStringArgument` and `z.preprocess`. Preserve schema defaults. Call it after building `shape` in `buildZedMcpServer`.

- [ ] **Step 4: Run tests**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-bridge.ts test/tool-bridge-options.test.ts
git commit -m "fix: coerce string tool arguments before validation"
```

---

### Task 6: Descrição de ferramenta com lista de subagentes

**Files:**
- Modify: `src/tool-bridge.ts:54-58`
- Test: `test/tool-bridge-options.test.ts`

**Interfaces:**
- Produces: `fitToolDescription(description: string, limit?: number): string`

- [ ] **Step 1: Write failing test**

```ts
const description = "generic guidance\n\nAvailable subagents:\n- writer\n- reviewer".padEnd(9000, "x");
const fitted = fitToolDescription(description, 8192);
assert.match(fitted, /^Available subagents:/);
assert.equal(fitted.length, 8192);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: FAIL; current function slices the beginning.

- [ ] **Step 3: Implement**

Port `opencode-claude-legacy/src/proxy.ts:2004-2025`: move the text starting at `Available subagents:` or `Available agent types and the tools they have access to:` to the front, then slice to the limit.

- [ ] **Step 4: Run tests**

Run: `node --test test/tool-bridge-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-bridge.ts test/tool-bridge-options.test.ts
git commit -m "fix: keep subagent lists when truncating tool descriptions"
```

---

### Task 7: Carregar `CLAUDE.md` do projeto

**Files:**
- Modify: `src/server.ts:459-478`
- Modify: `src/sdk.ts:260-269`
- Test: `test/sdk.test.ts`
- Test: `test/server-session.test.ts`

**Interfaces:**
- Consumes: `settingSources` existente em `StartClaudeQueryParams`.
- Produces: chat com `settingSources: ["project"]`.

- [ ] **Step 1: Write failing SDK test**

```ts
const captured = await startClaudeQuery({
  prompt: "hi",
  cwd: process.cwd(),
  isolateMcp: true,
  settingSources: ["project"],
  queryImpl: () => (input) => { captured = input; return (async function* () {})(); },
});
assert.deepEqual(captured.options?.settingSources, ["project"]);
```

- [ ] **Step 2: Run the server test to verify it fails**

Run: `node --test test/server-session.test.ts`
Expected: FAIL; the captured chat options have `settingSources: []` because `isolateMcp` wins.

- [ ] **Step 3: Implement**

Pass `settingSources: ["project"]` in the chat `startClaudeQuery` call in `server.ts`. Keep `isolateMcp: true`; `strictMcpConfig`, `disableAllHooks`, `disableClaudeAiConnectors` continuam.

- [ ] **Step 4: Run tests**

Run: `node --test test/sdk.test.ts test/server-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/sdk.ts test/sdk.test.ts test/server-session.test.ts
git commit -m "fix: load project CLAUDE.md instructions"
```

---

### Task 8: Detecção de meta requests do Zed

**Files:**
- Create: `src/request-kind.ts`
- Test: `test/request-kind.test.ts`

**Interfaces:**
- Produces:

```ts
export type MetaRequestKind = "title" | "summary" | "commit" | null;
export function detectMetaRequestKind(messages: HistoryMessage[]): MetaRequestKind;
export function buildMetaPrompt(kind: Exclude<MetaRequestKind, null>, messages: HistoryMessage[]): string;
```

- [ ] **Step 1: Write failing tests**

```ts
const system = (text: string) => [{ role: "system", content: text }, { role: "user", content: "the request" }];

assert.equal(detectMetaRequestKind(system("Generate a concise 3-7 word title for this conversation, omitting punctuation.")), "title");
assert.equal(detectMetaRequestKind(system("Summarize the conversation so far to free up context.")), "summary");
assert.equal(detectMetaRequestKind(system("Compact the conversation so far.")), "summary");
assert.equal(detectMetaRequestKind(system("You are an expert at writing Git commits.")), "commit");
assert.equal(detectMetaRequestKind(system("You are a coding agent.")), null);

const prompt = buildMetaPrompt("commit", system("You are an expert at writing Git commits."));
assert.match(prompt, /<instructions>/);
assert.match(prompt, /the request/);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/request-kind.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

Use `extractTextContent` from `translate.ts` for system and latest user. Recognize the exact markers above; title wins over commit, commit over summary. `buildMetaPrompt` returns:

```text
<instructions>
{system or default instructions}
</instructions>

{user text}
```

Default title instructions: "Create a concise 3-7 word title for the request below. Output only the title, with no quotation marks."

- [ ] **Step 4: Run tests**

Run: `node --test test/request-kind.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/request-kind.ts test/request-kind.test.ts
git commit -m "feat: detect zed title, summary and commit requests"
```

---

### Task 9: Turno utilitário para meta requests

**Files:**
- Modify: `src/server.ts:271-657`
- Modify: `src/sdk.ts:299-303`
- Test: `test/server-protocol.test.ts`

**Interfaces:**
- Consumes: `detectMetaRequestKind`, `buildMetaPrompt`.
- Produces: query meta sem sessão, sem tools, com `persistSession: false`.

- [ ] **Step 1: Write failing integration test**

Post a body with system `"You are an expert at writing Git commits."` and a user diff. Fake starter captures options. Assert:

```ts
assert.equal(captured.options.persistSession, false);
assert.equal(captured.options.maxTurns, 1);
assert.deepEqual(captured.options.thinking, { type: "disabled" });
assert.deepEqual(captured.options.settingSources, []);
assert.deepEqual(captured.options.skills, []);
assert.equal(captured.options.mcpServers, undefined);
assert.deepEqual(captured.options.tools, []);
assert.match(captured.options.systemPrompt as string, /text generation helper/);
```

Also assert `getForeignSessionId("any")` remains undefined and the response text is returned.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server-protocol.test.ts`
Expected: FAIL; meta request runs as a full agent turn.

- [ ] **Step 3: Implement**

In `handleChat`, compute `metaKind`. If non-null:

- use an ephemeral key `meta:${randomUUID()}`;
- skip parked bridge lookup;
- skip `recordTurnStart` and `setForeignSessionId`;
- `prompt = buildMetaPrompt(...)`;
- no tools/MCP;
- `systemPrompt: UTILITY_SYSTEM_PROMPT`;
- options above;
- after response, `deleteBridge` / close.

Chat path unchanged.

- [ ] **Step 4: Pass `autoCompactEnabled: false` explicitly**

In `src/sdk.ts`, change:

```ts
if (params.autoCompactEnabled !== false) options.autoCompactEnabled = true;
```

to also set `options.autoCompactEnabled = false` when the param is false. Add an assertion in the meta test:

```ts
assert.equal(captured.options.autoCompactEnabled, false);
```

- [ ] **Step 5: Run tests**

Run: `node --test test/server-protocol.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/sdk.ts test/server-protocol.test.ts
git commit -m "feat: run zed meta requests as utility turns"
```
