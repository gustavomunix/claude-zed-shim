# Claude Zed Shim v2 — Session Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar a máquina de estados de sessão do `opencode-claude-legacy` para o shim: boundaries, rewind, fork, detecção de transcript apagado e transferência de histórico.

**Architecture:** `store.ts` guarda bindings e boundaries compatíveis com o arquivo atual. `session-transcript.ts` lê os `.jsonl` do Claude Code. `resume.ts` decide o plano de resume como função pura. `server.ts` executa I/O, fork e a query.

**Tech Stack:** TypeScript, `node:fs`, `node:crypto`, Agent SDK `forkSession`.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-zed-shim-v2-design.md`

## Global Constraints

- `sessions.json` antigo continua legível; binding sem `turns` é `untracked`.
- Nada de credenciais em log.
- Fork só quando a chain depois do leaf não estiver limpa.
- Se o leaf não existir no arquivo, cair para transferência de histórico.
- Testes usam diretórios temporários; não tocar `$HOME` real.

## Review Focus

- Um turno novo normal não pode ser classificado como rewind.
- Um rewind não pode ressuscitar turnos que o usuário apagou.
- Um transcript apagado não pode iniciar sessão vazia em silêncio.
- Um turno parkeado não pode ser retomado com histórico divergente.
- Dois turnos concluídos não podem deixar bridge pendurada no pool.

---

### Task 1: `matchTurnHistory` compatível com o ref

**Files:**
- Modify: `src/store.ts:132-157`
- Test: `test/session-store.test.ts`

**Interfaces:**
- Consumes: `TurnBoundary` da Task 2.
- Produces: `HistoryMatch` com `untracked | latest | rewind | diverged`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTurnHistory, type TurnBoundary } from "../src/store.ts";

const turns: TurnBoundary[] = [
  { count: 1, hash: "a", leafUuid: "leaf-a", sessionId: "s1" },
  { count: 2, hash: "b", leafUuid: "leaf-b", sessionId: "s1" },
];

describe("matchTurnHistory", () => {
  it("returns untracked without boundaries", () => {
    assert.deepEqual(matchTurnHistory([], ["a"]), { kind: "untracked" });
  });

  it("matches the latest boundary with extra history", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a", "b", "c"]), { kind: "latest", count: 2 });
  });

  it("detects a rewind to an earlier boundary", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a"]), {
      kind: "rewind",
      index: 0,
      leafUuid: "leaf-a",
      sessionId: "s1",
    });
  });

  it("detects divergence", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a", "x"]), { kind: "diverged" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-store.test.ts`
Expected: FAIL on rewind/latest shapes; current implementation compares by array index.

- [ ] **Step 3: Implement the ref algorithm**

Use the logic from `opencode-claude-legacy/src/session-store.ts:279-301`:

```ts
const latest = turns.at(-1);
if (!latest) return { kind: "untracked" };
const n = prints.length;
if (n >= latest.count && prints[latest.count - 1] === latest.hash) {
  return { kind: "latest", count: latest.count };
}
for (let i = turns.length - 2; i >= 0; i--) {
  const turn = turns[i]!;
  if (turn.count === n && prints[n - 1] === turn.hash) {
    return {
      kind: "rewind",
      index: i,
      leafUuid: turn.leafUuid,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    };
  }
}
return { kind: "diverged" };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/session-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/session-store.test.ts
git commit -m "fix: match session turn boundaries like the reference"
```

---

### Task 2: Boundaries, pending turns e merge do binding

**Files:**
- Modify: `src/store.ts:20-130`
- Test: `test/session-store.test.ts`

**Interfaces:**
- Consumes: `writeJsonFileAtomic`, `readJsonFile`.
- Produces:
  - `recordTurnStart(key, boundary, before?)`
  - `rewindSessionTurns(key, index)`
  - `setForeignSessionId` com merge de `pendingTurns` e atualização do leaf

- [ ] **Step 1: Write failing tests**

```ts
it("records a pending boundary before the binding exists", () => {
  const key = "pending";
  recordTurnStart(key, { count: 1, hash: "a" });
  setForeignSessionId(key, "s1", { leafUuid: "leaf-a" });
  assert.deepEqual(getSessionTurns(key).map((t) => [t.count, t.hash, t.leafUuid]), [
    [1, "a", "leaf-a"],
  ]);
});

it("appends a new boundary and updates the last leaf", () => {
  setForeignSessionId("k2", "s1", { leafUuid: "leaf-a" });
  recordTurnStart("k2", { count: 1, hash: "a" });
  setForeignSessionId("k2", "s1", { leafUuid: "leaf-b" });
  recordTurnStart("k2", { count: 2, hash: "b" });
  setForeignSessionId("k2", "s1", { leafUuid: "leaf-c" });
  assert.deepEqual(getSessionTurns("k2").map((t) => t.count), [1, 2]);
  assert.equal(getSessionTurns("k2").at(-1)?.leafUuid, "leaf-c");
});

it("rewinds and forgets later boundaries", () => {
  setForeignSessionId("k3", "s1", { leafUuid: "leaf-a" });
  recordTurnStart("k3", { count: 1, hash: "a" });
  recordTurnStart("k3", { count: 2, hash: "b" });
  rewindSessionTurns("k3", 0);
  assert.equal(getSessionTurns("k3").length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-store.test.ts`
Expected: FAIL; `recordTurnStart` currently only appends and no pending merge, `rewind` is unused.

- [ ] **Step 3: Implement**

Port from `opencode-claude-legacy/src/session-store.ts:195-258` without the `written` cache optimization:

- `pendingTurns: Map<string, TurnBoundary[]>`;
- `recordTurnStart` appends `before` when the binding has no turns, appends the new boundary, stores pending if no binding, otherwise saves;
- `setForeignSessionId` merges pending turns, deletes the pending entry, updates the last boundary's `leafUuid`/`sessionId`, slices to 100;
- `rewindSessionTurns` truncates and updates `leafUuid` only when the boundary belongs to the current session;
- `clearForeignSessionId` also deletes the pending entry for the key.

- [ ] **Step 4: Run tests**

Run: `node --test test/session-store.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/session-store.test.ts
git commit -m "fix: record and rewind session turn boundaries"
```

---

### Task 3: Leitura do transcript Claude Code

**Files:**
- Create: `src/session-transcript.ts`
- Test: `test/session-transcript.test.ts`

**Interfaces:**
- Produces:
  - `type LeafChainState = "clean" | "branched" | "missing"`
  - `findClaudeSessionFile(sessionId, configDir?): string | null`
  - `sessionFileHasEntry(file, uuid): boolean`
  - `sessionChainAfterLeaf(file, leafUuid): LeafChainState`
  - `lastChainEntryUuid(file): string | undefined`

- [ ] **Step 1: Write failing tests**

Create a temp `projects/demo/s1.jsonl`:

```jsonl
{"type":"user","uuid":"u1","parentUuid":null}
{"type":"assistant","uuid":"a1","parentUuid":"u1"}
{"type":"user","uuid":"u2","parentUuid":"a1"}
```

Assertions:

```ts
assert.equal(findClaudeSessionFile("s1", configDir), file);
assert.equal(sessionFileHasEntry(file, "a1"), true);
assert.equal(sessionFileHasEntry(file, "missing"), false);
assert.equal(sessionChainAfterLeaf(file, "u1"), "clean");
assert.equal(lastChainEntryUuid(file), "u2");
```

Then append a side branch:

```jsonl
{"type":"assistant","uuid":"side","parentUuid":"other"}
```

Assert `sessionChainAfterLeaf(file, "u1") === "branched"`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-transcript.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

Port `opencode-claude-legacy/src/session-store.ts:309-480,522-540`. Keep the backward chunk reads. `findClaudeSessionFile` searches every directory under `<configDir or ~/.claude>/projects` for `<id>.jsonl`.

- [ ] **Step 4: Run tests**

Run: `node --test test/session-transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-transcript.ts test/session-transcript.test.ts
git commit -m "feat: inspect claude session transcripts"
```

---

### Task 4: Planejador puro de resume

**Files:**
- Create: `src/resume.ts`
- Test: `test/resume.test.ts`

**Interfaces:**
- Consumes: `matchTurnHistory`, `historyAfterUserCount`, `LeafChainState`, `HistoryMessage` exportado de `src/translate.ts`.
- Produces:

```ts
export type SessionFileProbe = {
  exists: boolean;
  hasEntry: (uuid: string) => boolean;
  chainAfterLeaf: (uuid: string) => LeafChainState;
  lastEntry: () => string | undefined;
};

export type ResumePlan = {
  resume?: string;
  forkAt?: { sessionId: string; leafUuid: string };
  missedMessages: HistoryMessage[];
  transcript: "none" | "missed" | "history";
  clearBinding: boolean;
  rewindIndex?: number;
  reason: "no-session" | "missing-file" | "latest" | "rewind" | "rewind-no-leaf" | "diverged" | "untracked";
};

export function planResume(input: {
  turns: TurnBoundary[];
  prints: string[];
  priorMessages: HistoryMessage[];
  sessionId?: string;
  leafUuid?: string;
  probeFor: (sessionId: string) => SessionFileProbe | null;
}): ResumePlan;
```

`probeFor` é necessário porque um boundary de rewind pode apontar para uma sessão anterior (antes de um fork); o servidor resolve o arquivo daquela sessão, não só da atual.


- [ ] **Step 1: Write failing tests**

Cover:

```ts
it("transfers history without a session", () => {
  assert.deepEqual(planResume({ turns: [], prints: ["a"], priorMessages: [msg("a")], probeFor: () => null }), {
    missedMessages: [msg("a")],
    transcript: "history",
    clearBinding: false,
    reason: "no-session",
  });
});

it("resumes latest and injects missed messages", () => {
  const plan = planResume({
    turns: [{ count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" }],
    prints: ["a", "b"],
    priorMessages: [msg("a"), msg("b")],
    sessionId: "s1",
    leafUuid: "l1",
    probeFor: () => probe({ chain: "clean" }),
  });
  assert.equal(plan.resume, "s1");
  assert.equal(plan.transcript, "missed");
  assert.deepEqual(plan.missedMessages, [msg("b")]);
});

it("forks a branched rewind", () => {
  const plan = planResume({
    turns: [
      { count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" },
      { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
    ],
    prints: ["a"],
    priorMessages: [msg("a")],
    sessionId: "s1",
    leafUuid: "l2",
    probeFor: () => probe({ chain: "branched", has: true }),
  });
  assert.deepEqual(plan.forkAt, { sessionId: "s1", leafUuid: "l1" });
  assert.equal(plan.rewindIndex, 0);
});

it("transfers history when the session file is missing", () => {
  const plan = planResume({
    turns: [],
    prints: ["a"],
    priorMessages: [msg("a")],
    sessionId: "s1",
    probeFor: () => ({ exists: false, hasEntry: () => false, chainAfterLeaf: () => "missing", lastEntry: () => undefined }),
  });
  assert.equal(plan.clearBinding, true);
  assert.equal(plan.transcript, "history");
  assert.equal(plan.resume, undefined);
});

it("transfers history when the rewind leaf is gone", () => {
  const plan = planResume({
    turns: [
      { count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" },
      { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
    ],
    prints: ["a"],
    priorMessages: [msg("a")],
    sessionId: "s1",
    leafUuid: "l2",
    probeFor: () => probe({ chain: "clean", has: false }),
  });
  assert.equal(plan.clearBinding, true);
  assert.equal(plan.transcript, "history");
  assert.equal(plan.resume, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/resume.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

Export `HistoryMessage` from `src/translate.ts` (it already exists there as a local type). Import it in `resume.ts`.

Rules from `opencode-claude-legacy/src/proxy.ts:1286-1425`:

- no session id → history;
- missing file → clear + history;
- `latest` → missed messages after `count`;
- `rewind` with leaf:
  - `source = match.sessionId ?? sessionId`;
  - `sourceProbe = probeFor(source)`;
  - se `sourceProbe` ausente, não existe, ou `!sourceProbe.hasEntry(leaf)` → clear + history;
  - `rewindIndex`;
  - if `source !== sessionId` or `sourceProbe.lastEntry() !== leaf` or `sourceProbe.chainAfterLeaf(leaf) !== "clean"` → `forkAt` com `source`;
  - else resume `source`.
- `rewind` without leaf → resume same session, no transcript;
- `diverged` → clear + history;
- `untracked` → resume same session, no transcript.

- [ ] **Step 4: Run tests**

Run: `node --test test/resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resume.ts test/resume.test.ts
git commit -m "feat: plan session resume, rewind and fork"
```

---

### Task 5: Integrar resume no servidor

**Files:**
- Modify: `src/server.ts:271-657`
- Modify: `src/sdk.ts:48-53,238-434`
- Test: `test/server-session.test.ts`
- Create: `test/helpers/server.ts`

**Interfaces:**
- Consumes: `planResume`, `findClaudeSessionFile`, `sessionFileHasEntry`, `sessionChainAfterLeaf`, `lastChainEntryUuid`, `forkClaudeSession`.
- Produces:
  - `setClaudeQueryStarter(starter | null)`
  - `setClaudeSessionForker(forker | null)`
  - `startServer(port): Server` (return the HTTP server)

- [ ] **Step 1: Add injectable seams**

In `src/sdk.ts`:

```ts
let sessionForker: typeof forkClaudeSession = forkClaudeSession;
export function setClaudeSessionForker(forker: typeof forkClaudeSession | null): void {
  sessionForker = forker ?? forkClaudeSession;
}
export function getClaudeSessionForker(): typeof forkClaudeSession {
  return sessionForker;
}

let queryStarter: typeof startClaudeQuery = startClaudeQuery;
export function setClaudeQueryStarter(starter: typeof startClaudeQuery | null): void {
  queryStarter = starter ?? startClaudeQuery;
}
export function getClaudeQueryStarter(): typeof startClaudeQuery {
  return queryStarter;
}
```

`server.ts` uses `getClaudeQueryStarter()` and `getClaudeSessionForker()`.

- [ ] **Step 2: Write failing integration test**

Create a helper that:

1. sets `XDG_DATA_HOME` and `CLAUDE_CONFIG_DIR` to temp dirs;
2. sets `setAuthStatusProbe(async () => null)`;
3. starts `startServer(0)` and reads `server.address().port`;
4. posts a chat body with `fetch`;
5. on teardown calls `server.close()`, `clearAllBridges()`, `setClaudeQueryStarter(null)`, `setClaudeSessionForker(null)` and restores env.

Fake starter captures `options` and returns a handle yielding:

```ts
{ type: "result", is_error: false, session_id: "s1", uuid: "u1", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }
```

Test 1: first turn has no `resume`.
Test 2: create `s1.jsonl` in the temp config project dir, post a follow-up; assert `captured.options.resume === "s1"` and prompt is only the new user message.
Test 3: delete the file and post again; assert no `resume` and prompt contains the transferred history.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/server-session.test.ts`
Expected: FAIL; server has no injectable starter and no resume planner.

- [ ] **Step 4: Integrate `planResume`**

In `startNewTurn`, before `startClaudeQuery`:

1. `const sessionId = getForeignSessionId(key)`.
2. `const probeFor = (id: string) => { const file = findClaudeSessionFile(id, configDir); return file ? { exists: true, hasEntry: (uuid) => sessionFileHasEntry(file, uuid), chainAfterLeaf: (uuid) => sessionChainAfterLeaf(file, uuid), lastEntry: () => lastChainEntryUuid(file) } : null; }`.
3. `const prints = userHistoryFingerprints(messages)` and `const before = userHistoryFingerprints(priorMessages)`.
4. `const plan = planResume({ turns: getSessionTurns(key), prints: before, priorMessages, sessionId, leafUuid: getSessionLeafUuid(key), probeFor })`.
6. Apply:
   - `clearBinding` → `clearForeignSessionId(key)`;
   - `rewindIndex` → `rewindSessionTurns(key, plan.rewindIndex)`;
   - `forkAt` → `forked = await getClaudeSessionForker()(...)`; `setForeignSessionId(key, forked, { modelId, cwd, leafUuid: lastChainEntryUuid(forkedFile) })`; `resume = forked`;
   - else `resume = plan.resume`.
7. `missedMessages = plan.missedMessages`.
8. `transcript = plan.transcript === "history" ? buildConversationTranscript(priorMessages) : plan.transcript === "missed" ? buildConversationTranscript(missedMessages) : ""`.
9. If `prints.length > 0`, call `recordTurnStart(key, { count: prints.length, hash: prints.at(-1)! }, before)` after the plan, before starting the query.

- [ ] **Step 5: Update parked-bridge divergence check**

Before resolving pending tools, use `matchTurnHistory` and stop on `rewind`/`diverged`, as in `server.ts:313-319`. Keep `existing = undefined` after stopping.

- [ ] **Step 6: Run tests**

Run: `node --test test/server-session.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/sdk.ts test/server-session.test.ts test/helpers/server.ts
git commit -m "feat: resume and rewind claude sessions in the server"
```

---

### Task 6: Limpar bridge de turno concluído

**Files:**
- Modify: `src/server.ts:513-597`
- Test: `test/server-session.test.ts`

**Interfaces:**
- Consumes: `deleteBridge` de `src/pool.ts`.
- Produces: bridge removida quando o stream termina sem park.

- [ ] **Step 1: Write failing test**

After a non-parked turn completes, assert:

```ts
assert.equal(findBridgeByConversation(key), undefined);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server-session.test.ts`
Expected: FAIL; bridge remains no pool.

- [ ] **Step 3: Implement**

In `consumeStream`'s `finally`, when `!handedOff`, call `handle?.close()` and `deleteBridge(bridgeId)`. Do not delete when `handedOff` is true (parked turn).

- [ ] **Step 4: Run tests**

Run: `node --test test/server-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-session.test.ts
git commit -m "fix: remove completed bridges from the pool"
```
